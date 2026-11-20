/**
 * Переходы по QR-кодам заказчика — из общего сервиса коротких ссылок
 * qr.alavenir.tech, где эти коды и созданы. Раньше их было видно только в
 * его админке; теперь — ещё и разделом на /stats.
 *
 * Сервис отдаёт статистику внешним страницам: /api/stats/*, только чтение,
 * заголовок X-Api-Key. Руководство: https://qr.alavenir.tech/api/stats/docs.
 * Сканирования там — переходы людей: боты и превью мессенджеров (ссылку
 * переслали в чат) в счёт не входят. Дни — по местному времени сервиса,
 * UTC+3, как и московское время на /stats.
 *
 * Переменные окружения:
 *   QR_STATS_KEY — ключ выгрузки (по руководству это общий пароль наших
 *                  админок). Нет — раздел на /stats пишет, что не настроен.
 *   QR_CODES     — какие коды показывать, через запятую; по умолчанию наши семь.
 *   QR_STATS_URL — адрес выгрузки, если сервис переедет.
 */
const BASE = (process.env.QR_STATS_URL ?? 'https://qr.alavenir.tech/api/stats').replace(/\/+$/, '')
const KEY = process.env.QR_STATS_KEY ?? ''
export const QR_CODES = (process.env.QR_CODES
  ?? 'questika_1,questika_2,rso_max,instructions_acquaintance,initial_acquaintance,max_android,max_web')
  .split(',').map((code) => code.trim()).filter(Boolean)

/** Дольше этого QR-сервис не ждём: страница статистики не должна висеть. */
const TIMEOUT_MS = 8000
/** Одна выгрузка на минуту: summary сервис каждый раз считает заново. */
const CACHE_MS = 60_000
/** Сервис не ответил — столько не спрашиваем снова, чтобы /stats не ждала его каждый раз. */
const ERROR_CACHE_MS = 30_000
/** Сколько последних сканирований показывать списком. */
const RECENT = 50
/** Сканирования выгружаются страницами; больше стольких не листаем. */
const MAX_PAGES = 20

async function call(path, params) {
  const response = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'X-Api-Key': KEY },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 401) throw new Error('QR-сервис не принял ключ — проверьте QR_STATS_KEY')
  if (!response.ok) throw new Error(`QR-сервис ответил ${response.status}`)
  return response.json()
}

/** Местная дата сервиса (UTC+3) — так он считает дни и понимает from/to. */
const localDay = (date) => new Date(new Date(date).getTime() + 3 * 3600_000).toISOString().slice(0, 10)

/** Все сканирования по кодам, по возрастанию — сервис отдаёт их страницами. */
async function allClicks(codes) {
  const items = []
  let after = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items: chunk, next_after_id: next } = await call('/clicks', { codes, after_id: String(after), limit: '5000' })
    items.push(...chunk)
    if (next === null || next === undefined) break
    after = next
  }
  return items
}

let cache = null

/**
 * { state: 'off' } — ключ не задан; { state: 'error', message } — сервис не
 * ответил; { state: 'ok', codes, links, summary, recent } — данные.
 */
export async function readQrScans() {
  // Пустой список кодов сервис понял бы как «все ссылки» — чужие тоже.
  if (!KEY || QR_CODES.length === 0) return { state: 'off' }
  if (cache && Date.now() - cache.at < (cache.value.state === 'ok' ? CACHE_MS : ERROR_CACHE_MS)) return cache.value
  try {
    const codes = QR_CODES.join(',')
    const links = await call('/links', { codes })
    // По дням — с создания самой ранней из ссылок: так это вся их история.
    const first = links.map((link) => link.created_at).sort()[0]
    const today = localDay(new Date())
    const [summary, clicks] = await Promise.all([
      call('/summary', { codes, from: first ? localDay(first) : today, to: today, per_link: 'true' }),
      allClicks(codes),
    ])
    const value = { state: 'ok', codes: QR_CODES, links, summary, recent: clicks.slice(-RECENT).reverse() }
    cache = { at: Date.now(), value }
    return value
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'QR-сервис не ответил за 8 секунд' : error?.message ?? String(error)
    console.error('[переходы QR]', message)
    const value = { state: 'error', message }
    cache = { at: Date.now(), value }
    return value
  }
}
