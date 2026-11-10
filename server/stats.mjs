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
 *
 * Здесь же — нажатия кнопок на странице стикера (таблица sticker_clicks):
 * «Сохранить картинку» и «Создать стикер» — переход в бота.
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
  model       VARCHAR(64)  NULL     COMMENT 'модель генерации, id на kie.ai',
  received_at DATETIME(3)  NOT NULL COMMENT 'когда строка дошла до сервера, UTC',
  PRIMARY KEY (id),
  UNIQUE KEY uid (uid),
  KEY started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Генерации маскотов: одна строка — одна генерация'`

/*
 * Нажатия на странице стикера — той, куда ведёт QR с панели. shot — id
 * картинки (/i/<id>): одна картинка — один посетитель, так что по нему
 * видно, сколько разных людей нажали, — один и тот же мог нажать не раз.
 */
const CLICKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sticker_clicks (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  button     VARCHAR(16) NOT NULL COMMENT 'save — «Сохранить картинку», bot — «Создать стикер» (переход в бота)',
  shot       VARCHAR(32) NOT NULL COMMENT 'id картинки на странице (/i/<id>)',
  clicked_at DATETIME(3) NOT NULL COMMENT 'когда нажали, UTC',
  PRIMARY KEY (id),
  KEY clicked_at (clicked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Нажатия кнопок на странице стикера: одна строка — одно нажатие'`

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
      await migrate()
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

/**
 * Модель генерации, если панель её не прислала. Не присылают только версии
 * панели до выбора модели, а они умели одну — Nano Banana 2: модель нигде
 * не переопределялась (ни в .env.local, ни в сборке веб-версии).
 */
const LEGACY_MODEL = 'nano-banana-2'

/**
 * Таблица из прошлой версии — без колонки model. CREATE TABLE IF NOT EXISTS
 * её не добавит, а ADD COLUMN IF NOT EXISTS в MySQL 8 нет, поэтому сначала
 * смотрим в information_schema. Заодно подписываем старые строки — все они
 * от Nano Banana 2.
 */
async function migrate() {
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generations' AND COLUMN_NAME = 'model'`)
  if (columns.length > 0) return
  await pool.query(
    "ALTER TABLE generations ADD COLUMN model VARCHAR(64) NULL COMMENT 'модель генерации, id на kie.ai' AFTER status")
  const [result] = await pool.query('UPDATE generations SET model = ? WHERE model IS NULL', [LEGACY_MODEL])
  console.log(`[статистика] добавлена колонка model, старым строкам (${result.affectedRows}) — ${LEGACY_MODEL}`)
}

/*
 * Таблица нажатий заводится отдельно от основной: если с ней что-то не так,
 * статистика генераций от этого не ломается.
 */
let clicksReady = null

function ensureClicksTable() {
  if (!clicksReady) {
    clicksReady = ensureReady()
      .then(() => pool.query(CLICKS_SCHEMA))
      .catch((error) => {
        clicksReady = null
        throw error
      })
  }
  return clicksReady
}

/**
 * Нажатия, которые ещё не легли в базу. Телефон шлёт нажатие один раз и
 * не повторяет, так что, если база моргнула, повторяет сервер: держим
 * строки здесь и пробуем снова по таймеру. Время нажатия запомнено сразу —
 * поздняя запись его не сдвинет.
 */
const clickQueue = []
const CLICK_QUEUE_MAX = 5000
const CLICK_RETRY_MS = 30_000
let flushing = false

/** Записать нажатие. Ничего не ждёт: ответ телефону от базы не зависит. */
export function recordClick(button, shot) {
  if (!DB_HOST) return
  clickQueue.push([button, shot, new Date()])
  // База лежит долго — выбрасываем самые старые, чтобы не съесть память.
  if (clickQueue.length > CLICK_QUEUE_MAX) clickQueue.splice(0, clickQueue.length - CLICK_QUEUE_MAX)
  void flushClicks()
}

async function flushClicks() {
  if (flushing) return
  flushing = true
  try {
    while (clickQueue.length > 0) {
      const batch = clickQueue.splice(0, MAX_ROWS)
      try {
        await ensureClicksTable()
        await pool.query('INSERT INTO sticker_clicks (button, shot, clicked_at) VALUES ?', [batch])
        console.log('[статистика] нажатия:', batch.map(([button, shot]) => `${button} ${shot}`).join(', '))
      } catch (error) {
        clickQueue.unshift(...batch)
        console.error(`[статистика] нажатия не записаны (${clickQueue.length} в очереди), повторим:`,
          error?.message ?? error)
        return
      }
    }
  } finally {
    flushing = false
  }
}

/** Подключаемся сразу при старте, не дожидаясь первой строки. */
export function startStats() {
  if (!DB_HOST) return
  ensureReady().catch(() => {})
  // unref — таймер не держит процесс, если сервер решат остановить.
  setInterval(() => void flushClicks(), CLICK_RETRY_MS).unref()
}

const UID = /^[\w-]{8,64}$/
const STATUS = /^(success|cancelled|error:[a-z]{1,20})$/
/** id моделей kie.ai: буквы, цифры, точка, дефис, слэш — «grok-imagine/image-to-image». */
const MODEL = /^[\w./-]{1,64}$/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Оставить только годные строки. Негодные молча отбрасываем: панель всё
 * равно не сможет их исправить, а остальные из-за них терять незачем.
 * Модель не прислали — это старая версия панели, у неё была одна модель.
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
  }).map((row) => ({
    ...row,
    model: typeof row.model === 'string' && MODEL.test(row.model) ? row.model : LEGACY_MODEL,
  }))
}

/*
 * Чтение — для страницы статистики (server/statspage.mjs). Дни считаем по
 * Москве: CONVERT_TZ с числовым смещением работает и без таблиц часовых
 * поясов в MySQL, а летнего времени в Москве нет.
 */
const mskDay = (column) => `DATE_FORMAT(CONVERT_TZ(${column}, '+00:00', '+03:00'), '%Y-%m-%d')`
const TOTALS = `COUNT(*) AS total,
  SUM(status = 'success') AS success,
  SUM(status LIKE 'error:%') AS errors,
  SUM(status = 'cancelled') AS cancelled,
  AVG(CASE WHEN status = 'success' THEN duration_s END) AS avg_s,
  MIN(CASE WHEN status = 'success' THEN duration_s END) AS min_s,
  MAX(CASE WHEN status = 'success' THEN duration_s END) AS max_s`

/*
 * Номер генерации на странице — сквозной за всё время, по всем панелям и
 * сайту: 1, 2, 3… — по порядку, в каком строки пришли в базу. По нему видно,
 * какой это по счёту человек.
 *
 * Считается запросом (ROW_NUMBER по id), а не берётся из самого id: в id
 * бывают дыры — повторная отправка той же строки отбрасывается INSERT
 * IGNORE, но значение счётчика при этом всё равно тратится. А номер должен
 * идти подряд. Новые строки всегда получают id больше прежних, так что
 * номера уже записанных генераций не меняются.
 *
 * gen_no в таблице — счётчик самой панели (он же в её generations.csv).
 */
const NUMBERED = `SELECT ROW_NUMBER() OVER (ORDER BY id) AS n, started_at, finished_at, duration_s, status, model
  FROM generations`

/**
 * Итоги, разбивка по дням и по моделям, последние генерации — панель и
 * сайт вместе. По моделям — чтобы сравнивать их на живых посетителях:
 * сколько удачных и сколько в среднем ждали.
 */
export async function readStats({ limit = 200 } = {}) {
  await ensureReady()
  const [[totals]] = await pool.query(`SELECT ${TOTALS} FROM generations`)
  const [errors] = await pool.query(
    "SELECT status, COUNT(*) AS n FROM generations WHERE status LIKE 'error:%' GROUP BY status ORDER BY n DESC")
  const [days] = await pool.query(
    `SELECT ${mskDay('started_at')} AS day, ${TOTALS} FROM generations GROUP BY day ORDER BY day DESC LIMIT 60`)
  const [models] = await pool.query(`SELECT model, ${TOTALS} FROM generations GROUP BY model ORDER BY total DESC`)
  const [recent] = await pool.query(`SELECT * FROM (${NUMBERED}) numbered ORDER BY n DESC LIMIT ?`, [limit])
  // Нажатия не прочитались — страница всё равно покажет генерации.
  const clicks = await readClicks().catch((error) => {
    console.error('[статистика] нажатия не прочитались:', error?.message ?? error)
    return null
  })
  return { totals, errors, days, models, recent, clicks }
}

/**
 * Нажатия по кнопкам: сколько всего и у скольких разных картинок, с какого
 * момента считаем, и по дням (по Москве, как генерации).
 */
async function readClicks() {
  await ensureClicksTable()
  const [totals] = await pool.query(
    `SELECT button, COUNT(*) AS clicks, COUNT(DISTINCT shot) AS shots, MIN(clicked_at) AS since
     FROM sticker_clicks GROUP BY button`)
  const [days] = await pool.query(
    `SELECT ${mskDay('clicked_at')} AS day, SUM(button = 'save') AS save_clicks, SUM(button = 'bot') AS bot_clicks
     FROM sticker_clicks GROUP BY day ORDER BY day DESC LIMIT 60`)
  return { totals, days }
}

/** Все строки по номеру — для выгрузки в CSV. */
export async function allGenerations() {
  await ensureReady()
  const [rows] = await pool.query(`${NUMBERED} ORDER BY id`)
  return rows
}

/** Записать строки. Возвращает, сколько новых легло (повторы не считаются). */
export async function saveGenerations(rows) {
  if (rows.length === 0) return 0
  await ensureReady()
  const now = new Date()
  const values = rows.map((row) => [
    row.uid, row.source, row.number, new Date(row.startedAt), new Date(row.finishedAt), row.status, row.model, now,
  ])
  try {
    const [result] = await pool.query(
      'INSERT IGNORE INTO generations (uid, source, gen_no, started_at, finished_at, status, model, received_at) VALUES ?',
      [values],
    )
    state = 'ok'
    // Видно в логах Dokploy: так проверяется, что строки доходят.
    console.log(`[статистика] записано ${result.affectedRows} из ${rows.length}:`,
      rows.map((row) => `№${row.number} ${row.source} ${row.status} ${row.model}`).join(', '))
    return result.affectedRows
  } catch (error) {
    state = error?.sqlMessage ? 'ошибка базы' : 'нет связи с базой'
    console.error('[статистика] запись не удалась:', error?.message ?? error)
    throw error
  }
}
