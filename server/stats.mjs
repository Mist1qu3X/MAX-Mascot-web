/**
 * Статистика генераций в MySQL.
 *
 * Панель после каждой генерации присылает строку (POST /stats/generations):
 * номер, начало, конец, статус. Сама панель до базы не достаёт — база
 * доступна только из контейнеров на хостинге, — поэтому пишет сервер.
 *
 * Подключение — из переменных окружения DB_HOST, DB_PORT, DB_NAME, DB_USER,
 * DB_PASS. Нет DB_HOST — статистика выключена, страница и QR работают как
 * обычно. Упала база — тоже: панель получает 503 и пришлёт строки позже.
 *
 * Таблица создаётся здесь же при старте (CREATE TABLE IF NOT EXISTS):
 * схема живёт в репозитории, и после аварии база восстанавливается одним
 * деплоем. Время — в UTC, так требует админ базы.
 *
 * Драйвер mysql2 подгружается, только когда база задана: локальному серверу
 * панели (`npm run sticker` в MAX_PO) база не нужна, и драйвера у него нет.
 */

const DB_HOST = process.env.DB_HOST ?? ''

/** Сколько строк принимаем за раз — панель шлёт пачками по 50. */
export const MAX_ROWS = 200

/*
 * duration_s вычисляет сама база из начала и конца — хранимая вычисляемая
 * колонка, руками её не заполнить и не испортить.
 * uid — id строки с панели: повторная отправка той же строки (панель не
 * дождалась ответа и прислала снова) отбрасывается через INSERT IGNORE.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS generations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uid         VARCHAR(64)  NOT NULL COMMENT 'id строки с панели, защита от повторов',
  source      VARCHAR(16)  NOT NULL COMMENT 'panel — приложение на панели, web — веб-версия',
  gen_no      INT UNSIGNED NOT NULL COMMENT 'номер генерации на панели',
  started_at  DATETIME(3)  NOT NULL COMMENT 'начало генерации, UTC',
  finished_at DATETIME(3)  NOT NULL COMMENT 'конец генерации, UTC',
  duration_s  DECIMAL(8,1) AS (TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) / 1000000) STORED
              COMMENT 'длительность, секунды',
  status      VARCHAR(32)  NOT NULL COMMENT 'success | cancelled | error:<причина>',
  received_at DATETIME(3)  NOT NULL COMMENT 'когда строка дошла до сервера, UTC',
  PRIMARY KEY (id),
  UNIQUE KEY uid (uid),
  KEY started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Генерации маскотов: одна строка — одна генерация'`

let pool = null
let ready = null
/** Для /health и экрана проверки на панели. Без подробностей: они — в логе. */
let state = DB_HOST ? 'подключаемся' : 'выключена'

export function statsEnabled() {
  return Boolean(DB_HOST)
}

export function statsState() {
  return state
}

/**
 * Подключиться и создать таблицу. Не вышло — следующий вызов попробует
 * снова: база могла подняться позже сервера.
 */
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      if (!pool) {
        const { createPool } = await import('mysql2/promise')
        pool = createPool({
          host: DB_HOST,
          port: Number(process.env.DB_PORT ?? 3306),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASS,
          // Даты в обе стороны — в UTC, независимо от часового пояса сервера.
          timezone: 'Z',
          connectionLimit: 3,
          connectTimeout: 10_000,
          enableKeepAlive: true,
        })
      }
      await pool.query(SCHEMA)
      state = 'ok'
    })().catch((error) => {
      ready = null
      state = error?.code === 'ERR_MODULE_NOT_FOUND' ? 'нет драйвера mysql2'
        : error?.sqlMessage ? 'ошибка базы' : 'нет связи с базой'
      console.error('[статистика]', state + ':', error?.message ?? error)
      throw error
    })
  }
  return ready
}

/** Подключаемся сразу при старте, не дожидаясь первой строки. */
export function startStats() {
  if (DB_HOST) ensureReady().catch(() => {})
}

const UID = /^[\w-]{8,64}$/
const STATUS = /^(success|cancelled|error:[a-z]{1,20})$/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Оставить только годные строки. Негодные молча отбрасываем: панель всё
 * равно не сможет их исправить, а остальные из-за них терять незачем.
 */
export function cleanRows(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, MAX_ROWS).filter((row) => {
    if (!row || typeof row !== 'object') return false
    const start = Date.parse(row.startedAt)
    const end = Date.parse(row.finishedAt)
    return typeof row.uid === 'string' && UID.test(row.uid)
      && (row.source === 'panel' || row.source === 'web')
      && Number.isInteger(row.number) && row.number > 0 && row.number < 2 ** 31
      && Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < DAY_MS
      && typeof row.status === 'string' && STATUS.test(row.status)
  })
}

/** Записать строки. Возвращает, сколько новых легло (повторы не считаются). */
export async function saveGenerations(rows) {
  if (rows.length === 0) return 0
  await ensureReady()
  const now = new Date()
  const values = rows.map((row) => [
    row.uid, row.source, row.number, new Date(row.startedAt), new Date(row.finishedAt), row.status, now,
  ])
  try {
    const [result] = await pool.query(
      'INSERT IGNORE INTO generations (uid, source, gen_no, started_at, finished_at, status, received_at) VALUES ?',
      [values],
    )
    state = 'ok'
    // Видно в логах Dokploy: так проверяется, что строки доходят.
    console.log(`[статистика] записано ${result.affectedRows} из ${rows.length}:`,
      rows.map((row) => `№${row.number} ${row.source} ${row.status}`).join(', '))
    return result.affectedRows
  } catch (error) {
    state = error?.sqlMessage ? 'ошибка базы' : 'нет связи с базой'
    console.error('[статистика] запись не удалась:', error?.message ?? error)
    throw error
  }
}
