/**
 * Страница статистики генераций: GET /stats и выгрузка GET /stats.csv.
 *
 * Простая, без скриптов: сервер рисует HTML из базы на каждый запрос.
 * Время — московское: смотрят люди на мероприятии, а в базе лежит UTC.
 *
 * Вход — своя форма с одним полем пароля (стандартное окно браузера
 * обязательно спрашивает ещё и имя). Пароль — переменная STATS_PASSWORD:
 * в коде его нет, репозиторий публичный. Не задана — страница выключена.
 *
 * После входа браузер получает подписанную куку на 14 дней. Подпись
 * считается от пароля: сменили пароль — все старые входы недействительны,
 * а перезапуск сервера их не сбрасывает.
 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const PASSWORD = process.env.STATS_PASSWORD ?? ''
// Сравниваем не сами строки, а их хэши: так сравнение идёт за одинаковое
// время независимо от того, сколько символов совпало.
const SALT = randomBytes(16)
const EXPECTED = PASSWORD ? scryptSync(PASSWORD, SALT, 32) : null
const SESSION_KEY = PASSWORD ? scryptSync(PASSWORD, 'max-stats-session', 32) : null
const SESSION_DAYS = 14
const COOKIE = 'stats_session'

export function statsPageEnabled() {
  return Boolean(PASSWORD)
}

/** Верный ли пароль. Неверный — с секундной паузой от перебора. */
export async function passwordOk(password) {
  if (!EXPECTED) return false
  const ok = timingSafeEqual(await scryptAsync(String(password ?? ''), SALT, 32), EXPECTED)
  if (!ok) await new Promise((r) => setTimeout(r, 1000))
  return ok
}

const sign = (value) => createHmac('sha256', SESSION_KEY).update(value).digest('base64url')

/** Есть ли у браузера действующий вход. */
export function signedIn(req) {
  if (!SESSION_KEY) return false
  const value = (req.headers.cookie ?? '').split(/;\s*/)
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''
  const [expires, signature] = value.split('.')
  if (!expires || !signature || Number(expires) < Date.now()) return false
  const expected = sign(expires)
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

/** Кука входа. Secure — когда пришли по https (за Traefik это x-forwarded-proto). */
export function signInCookie(req) {
  const expires = String(Date.now() + SESSION_DAYS * 86_400_000)
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  return `${COOKIE}=${expires}.${sign(expires)}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; SameSite=Strict${secure}`
}

export const SIGN_OUT_COOKIE = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`

const STATUS = {
  success: 'успех',
  cancelled: 'прервана',
  'error:config': 'ошибка: сервис не настроен',
  'error:network': 'ошибка: нет связи',
  'error:policy': 'ошибка: кадр отклонён моделью',
  'error:gesture': 'ошибка: жест на кадре',
  'error:timeout': 'ошибка: не уложились по времени',
  'error:api': 'ошибка: сбой сервиса',
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const num = (value) => (value === null || value === undefined ? null : Number(value))
const seconds = (value) => (num(value) === null ? '—' : num(value).toFixed(1).replace('.', ','))

/** Москва — UTC+3 круглый год. */
function msk(date) {
  const iso = new Date(new Date(date).getTime() + 3 * 3600_000).toISOString()
  return { day: iso.slice(0, 10), time: iso.slice(11, 19) }
}

function statusCell(status) {
  const kind = status === 'success' ? 'ok' : status === 'cancelled' ? 'off' : 'bad'
  return `<td class="${kind}">${esc(STATUS[status] ?? status)}</td>`
}

const percent = (part, total) => (total ? ` (${Math.round((100 * part) / total)}%)` : '')

const STYLE = `
@font-face{font-family:'VK Sans Display';font-weight:400;src:url('/fonts/VKSansDisplay-regular.woff2') format('woff2')}
@font-face{font-family:'VK Sans Display';font-weight:600;src:url('/fonts/VKSansDisplay-demibold.woff2') format('woff2')}
:root{--void:#0d001a;--ink:#fff;--muted:rgb(255 255 255/.62);--line:rgb(255 255 255/.12);
  --ok:#5ee0a0;--bad:#ff7a8a;--off:rgb(255 255 255/.5);--accent:#7a36ff}
*{box-sizing:border-box}
body{margin:0;padding:28px 16px 48px;background:var(--void);color:var(--ink);
  font:15px/1.4 'VK Sans Display',-apple-system,'Helvetica Neue',sans-serif;max-width:1000px;margin-inline:auto}
h1{font-size:26px;margin:0 0 4px;font-weight:600}
h2{font-size:18px;margin:28px 0 10px;font-weight:600}
.muted{color:var(--muted);margin:0}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}
nav a{color:var(--ink);text-decoration:none;padding:7px 14px;border-radius:999px;background:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}
.card{border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.card b{display:block;font-size:26px;font-weight:600}
.card small{font-size:15px;font-weight:400;color:var(--muted)}
.card span{color:var(--muted);font-size:13px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:400;font-size:13px}
tr:last-child td{border-bottom:0}
td.ok{color:var(--ok)} td.bad{color:var(--bad)} td.off{color:var(--off)} p.bad{color:var(--bad)}
.signin{max-width:420px;margin:22vh auto 0;text-align:center}
.login{display:flex;gap:8px;margin-top:20px}
.login input{flex:1;min-width:0;font:inherit;font-size:16px;color:var(--ink);background:transparent;
  border:1px solid var(--line);border-radius:999px;padding:10px 16px}
.login button{font:inherit;font-size:16px;color:#fff;background:var(--accent);border:0;border-radius:999px;padding:10px 20px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.top a{color:var(--muted);font-size:14px}
.r{text-align:right}
`

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

/** Форма входа: только пароль. */
export function renderSignIn(error) {
  return page('Статистика генераций', `<main class="signin"><h1>Статистика генераций</h1>
<form method="post" action="/stats/login" class="login">
<input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required>
<button type="submit">Войти</button></form>
${error ? `<p class="bad">${esc(error)}</p>` : ''}</main>`)
}

/** Страница, когда показать нечего: база выключена или не отвечает. */
export function renderUnavailable(state) {
  return page('Статистика генераций', `<h1>Статистика генераций</h1>
<p class="muted">База статистики недоступна: ${esc(state)}. Строки с панели не теряются — она пришлёт их, когда база ответит.</p>`)
}

export function renderStats({ totals, errors, days, recent }) {
  const total = num(totals.total) ?? 0
  const now = msk(new Date())

  const cards = [
    [total, 'всего генераций'],
    [`${num(totals.success) ?? 0}<small>${percent(num(totals.success), total)}</small>`, 'успешно'],
    [num(totals.errors) ?? 0, 'ошибок'],
    [num(totals.cancelled) ?? 0, 'прервано'],
    [`${seconds(totals.avg_s)} с`, `среднее время успешной (${seconds(totals.min_s)}–${seconds(totals.max_s)} с)`],
  ].map(([value, label]) => `<div class="card"><b>${value}</b><span>${esc(label)}</span></div>`).join('')

  const errorLine = errors.length
    ? `<p class="muted" style="margin-top:12px">Ошибки по причинам: ${errors
      .map((e) => `${esc((STATUS[e.status] ?? e.status).replace('ошибка: ', ''))} — ${num(e.n)}`).join(' · ')}</p>`
    : ''

  const dayRows = days.map((d) => `<tr><td>${esc(d.day)}</td><td class="r">${num(d.total)}</td>
<td class="r">${num(d.success)}</td><td class="r">${num(d.errors)}</td><td class="r">${num(d.cancelled)}</td>
<td class="r">${seconds(d.avg_s)}</td></tr>`).join('')

  const recentRows = recent.map((r) => {
    const start = msk(r.started_at)
    const end = msk(r.finished_at)
    return `<tr><td class="r">${num(r.gen_no)}</td><td>${start.day}</td><td>${start.time}</td>
<td>${end.time}</td><td class="r">${seconds(r.duration_s)}</td>${statusCell(r.status)}</tr>`
  }).join('')

  return page('Статистика генераций', `<div class="top"><h1>Статистика генераций</h1><a href="/stats/logout">выйти</a></div>
<p class="muted">Время московское. Обновлено ${now.day} в ${now.time} — обновите страницу, чтобы увидеть новые.</p>
<nav><a href="/stats.csv">Скачать CSV</a></nav>
<div class="cards">${cards}</div>${errorLine}
<h2>По дням</h2>
${days.length ? `<div class="scroll"><table><tr><th>день</th><th class="r">всего</th><th class="r">успех</th>
<th class="r">ошибки</th><th class="r">прервано</th><th class="r">среднее, с</th></tr>${dayRows}</table></div>` : '<p class="muted">Пока пусто.</p>'}
<h2>Последние генерации</h2>
${recent.length ? `<div class="scroll"><table><tr><th class="r">№</th><th>дата</th><th>начало</th><th>конец</th>
<th class="r">длит., с</th><th>статус</th></tr>${recentRows}</table></div>` : '<p class="muted">Пока пусто.</p>'}`)
}

/** CSV под Excel с русскими настройками — как generations.csv на панели. */
export function renderCsv(rows) {
  const lines = rows.map((r) => {
    const start = msk(r.started_at)
    const end = msk(r.finished_at)
    return [num(r.gen_no), start.day, start.time, end.time, seconds(r.duration_s), STATUS[r.status] ?? r.status].join(';')
  })
  return '﻿' + ['номер;дата;начало;конец;длительность, с;статус', ...lines].join('\r\n') + '\r\n'
}
