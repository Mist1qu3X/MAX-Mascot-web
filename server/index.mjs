/**
 * Локальный сервер панели: раздаёт страницу стикера и картинки маскотов.
 *
 * Зачем он вообще. Посетителю нужна веб-страница с кнопкой «Сохранить» —
 * значит, телефон должен куда-то сходить. Вместо внешнего хостинга страницу
 * раздаёт сама панель по локальной сети: телефон и панель в одном Wi-Fi.
 *
 * Что это даёт сверх «просто заменили хостинг»:
 *   - картинка лежит на панели, а не на kie.ai — ссылки не протухают
 *     через трое суток и не зависят от того, какой из двух хостов kie.ai
 *     выдал результат в этот раз;
 *   - страница и картинка на одном origin, поэтому CORS вообще не при чём
 *     и кнопка «Сохранить» работает всегда;
 *   - картинку с kie.ai скачивает Node, а не браузер, — на CORS ему всё равно.
 *
 * Два режима.
 *   Локально  — адрес страницы собирается из IP панели в домашней сети.
 *               Телефон обязан быть в том же Wi-Fi.
 *   На хостинге — задайте PUBLIC_URL, и адрес берётся из домена. Тогда
 *               телефон доходит и по мобильному интернету.
 *
 * Переменные:
 *   PORT        порт, по умолчанию 8787
 *   PUBLIC_URL  публичный адрес, например https://sticker.example.ru
 *   SHOT_TOKEN  пароль для POST /shot и POST /upload. На публичном хостинге
 *               обязателен: без него любой желающий заставит сервер качать
 *               что угодно и забьёт ему память.
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
 *               база MySQL для статистики генераций (server/stats.mjs).
 *               Без DB_HOST статистика выключена, остальное работает.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  allGenerations, cleanRows, loadQrImage, readQrCode, readStats, recordClick, saveGenerations, saveQrImage,
  startStats, statsEnabled, statsState,
} from './stats.mjs'
import {
  SIGN_OUT_COOKIE, passwordOk, renderCsv, renderQrMissing, renderQrPage, renderSignIn, renderStats,
  renderUnavailable, signInCookie, signedIn, statsPageEnabled,
} from './statspage.mjs'
import { lighten, lightenState } from './lighten.mjs'

const PORT = Number(process.env.PORT ?? 8787)
/** Задан — значит сервер публичный и адреса строим от домена, а не от IP. */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')
const SHOT_TOKEN = process.env.SHOT_TOKEN ?? ''
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'sticker', 'index.html')

/**
 * Сколько памяти отдаём под картинки. Считать штуками оказалось плохо:
 * маскот весит 1.3 МБ в jpg, но после вырезания фона это png на ~3 МБ,
 * и две сотни таких — уже под 600 МБ. На небольшом VPS это верный OOM.
 * Поэтому предел в байтах, а счётчик штук остаётся вторым ограничителем.
 */
const BUDGET_BYTES = Number(process.env.BUDGET_MB ?? 150) * 1024 * 1024
const KEEP = Number(process.env.KEEP ?? (PUBLIC_URL ? 200 : 24))
/**
 * Расширение по типу. Нужно именно в адресе: kie.ai определяет формат по
 * ссылке и на адрес без расширения отвечает «File type not supported».
 * Маршрут /i/ расширение всё равно отрезает, так что вреда от него нет.
 */
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Предел на один загружаемый кадр. Base64 раздувает данные на треть. */
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 12) * 1024 * 1024
/**
 * Сколько ждём kie.ai на одну попытку. Без предела зависший хост вешал
 * скачивание навсегда: цикл из трёх попыток не начинал вторую, обещание
 * не разрешалось, и телефон посетителя ждал картинку бесконечно.
 */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 15_000)
/**
 * Сколько телефон ждёт нашу копию, прежде чем мы отправим его к
 * первоисточнику. Своя копия почти всегда лучше (не протухает, тот же
 * origin, всегда с CORS), поэтому немного подождать стоит — но не дольше,
 * чем посетитель готов смотреть на спиннер.
 */
const WAIT_FOR_COPY_MS = Number(process.env.WAIT_FOR_COPY_MS ?? 2500)
/** Сколько байт сейчас занято — пересчитывать Map на каждый запрос дорого. */
let held = 0
/**
 * Последние скачивания: сколько заняло и откуда. Без этого «фотка долго
 * доходит» остаётся ощущением — не видно, кто тормозит: kie.ai, наш канал
 * или телефон. Отдаётся в /health, живёт в памяти, места не занимает.
 */
const timings = []
const TIMINGS_KEEP = 30

function note(record) {
  timings.push({ at: new Date().toISOString(), ...record })
  if (timings.length > TIMINGS_KEEP) timings.shift()
  const { kind, ms, bytes, original, host } = record
  const kb = (n) => `${(n / 1024).toFixed(0)} КБ`
  console.log(`[${kind}] ${ms} мс` +
    (original && original !== bytes ? `, ${kb(original)} → ${kb(bytes)}` : bytes ? `, ${kb(bytes)}` : '') +
    (host ? `, ${host}` : ''))
}
/**
 * id -> { pending }, где pending — обещание с телом и типом картинки.
 * Храним именно обещание, а не готовые байты: /shot обязан отвечать сразу,
 * иначе QR появляется на экране панели через 10–15 секунд после самого
 * маскота. Скачивание идёт фоном, а запрос картинки его дожидается.
 * В памяти: панель перезапускается, чистить нечего.
 */
const shots = new Map()

/**
 * Страницы, на которых считаем нажатия кнопок: id картинки -> сколько раз
 * нажали каждую. Отдельно от shots: картинки вытесняются по памяти, а до
 * кнопки «Создать стикер» посетитель может дойти и через час. Запись весит
 * байты, так что держим много.
 */
const clickable = new Map()
const CLICKABLE_KEEP = 10_000
/** Больше этого на одну картинку не засчитываем: столько руками не нажимают. */
const CLICKS_PER_SHOT = 20

function allowClicks(id) {
  if (clickable.has(id)) return
  clickable.set(id, { save: 0, bot: 0 })
  if (clickable.size > CLICKABLE_KEEP) clickable.delete(clickable.keys().next().value)
}

/** Домашние сети: 10/8, 172.16/12, 192.168/16. Только сюда попадёт телефон. */
function isLan(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31
}

/**
 * Адрес панели в локальной сети — его увидит телефон.
 *
 * Просто «первый непетлевой IPv4» брать нельзя: VPN и всякие служебные
 * туннели тоже непетлевые, а до них с телефона не достучаться. Поэтому
 * отсеиваем туннельные интерфейсы по имени и берём только адрес из
 * домашнего диапазона. Порядок интерфейсов системой не гарантирован,
 * так что полагаться на него нельзя.
 */
function lanHost() {
  const skip = /^(utun|tun|tap|ppp|awdl|llw|ipsec)/
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal && isLan(net.address)) return net.address
    }
  }
  return null
}

/** Откуда телефон возьмёт страницу: домен на хостинге или IP в локальной сети. */
function publicOrigin() {
  if (PUBLIC_URL) return PUBLIC_URL
  const host = lanHost()
  return host ? `http://${host}:${PORT}` : null
}

/*
 * x-robots-tag — на каждом ответе: сайт не для поисковиков. Страницы
 * стикера — фотографии живых людей, и в выдаче им делать нечего; заголовок,
 * в отличие от meta в HTML, закрывает и сами картинки (/i/…).
 * robots.txt здесь нарочно нет: запрет обхода спрятал бы от Google этот
 * заголовок, и уже найденная ссылка могла бы остаться в выдаче.
 */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'access-control-allow-origin': '*', 'x-robots-tag': 'noindex, nofollow', ...headers })
  res.end(body)
}

/** Кладём готовые байты и сразу отдаём id: качать их неоткуда. */
function store(body, type) {
  const id = randomUUID().replace(/-/g, '').slice(0, 12)
  held += body.length
  shots.set(id, { size: body.length, source: null, pending: Promise.resolve({ body, type }) })
  evict()
  return id
}

/**
 * Заводим место под картинку и сразу отдаём id — качаем фоном.
 * Node ходит на kie.ai без оглядки на CORS.
 */
function keep(url) {
  // 12 символов, а не 8: это фотографии живых людей, и хотя перебрать
  // 32 бита ради чужого маскота никто не станет, лишние 16 бит бесплатны —
  // на плотность QR четыре знака не влияют.
  const id = randomUUID().replace(/-/g, '').slice(0, 12)

  // Источник храним рядом: если скачать не успели, телефону есть куда уйти.
  const entry = { size: 0, source: url, filled: false }

  /*
   * Запись можно заполнить с двух сторон: сами скачаем с kie.ai или панель
   * пришлёт байты, которые у неё и так уже есть (POST /i/<id>). Кто успел,
   * тот и заполнил — второй молча выбрасывает своё, чтобы не задвоить
   * счётчик занятой памяти.
   */
  let settle
  const filled = new Promise((resolve) => { settle = resolve })
  entry.fill = (body, type, kind) => {
    if (entry.filled) return false
    entry.filled = true
    // Телефону и в базу — облегчённая копия (см. lighten.mjs): 2048 px на
    // 1–1,5 МБ ужимаются до 1080 px на пару сотен КБ за доли секунды. Кто
    // ждёт картинку, дождётся уже её.
    void lighten(body, type).then((light) => {
      note({ kind, ms: Date.now() - entry.startedAt, bytes: light.body.length, original: body.length })
      // Пока ужимали, запись могли вытеснить: тогда место в памяти уже не
      // её, но тому, кто ждёт картинку, и базе она всё равно нужна.
      if (shots.get(id) === entry) {
        entry.size = light.body.length
        held += entry.size
      }
      settle(light)
      evict()
      // И в базу, фоном: ссылка из QR должна открываться и после перезапуска.
      saveQrImage(id, new Date(entry.startedAt), light.type, light.body)
    })
    return true
  }
  entry.startedAt = Date.now()

  const downloading = (async () => {
    // Три попытки с паузой: один сетевой сбой не должен ронять картинку
    // навсегда. Без этого запись «отравлялась» — на панели оставалась
    // пустая рамка, и починить это можно было только новой генерацией.
    let response
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
        if (response.ok) break
        throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        if (attempt >= 2) throw error
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    const body = Buffer.from(await response.arrayBuffer())
    const type = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
    // Вес и учёт памяти — внутри fill(): он же следит, чтобы запись не
    // заполнили дважды и held не задвоился.
    entry.fill(body, type, 'скачали с kie.ai')
  })()
  // Ошибку разберём при запросе картинки; здесь глушим, чтобы Node не ругался
  // на необработанное отклонение и не валил процесс.
  downloading.catch((error) => {
    note({ kind: 'скачать не вышло', ms: Date.now() - entry.startedAt, host: String(error) })
  })

  /*
   * Ждём того, кто заполнит запись первым. Раньше здесь стояло само
   * скачивание, и провал делал ожидание вечным; теперь провал лишь значит,
   * что придётся дождаться панели или уйти к первоисточнику по таймауту.
   */
  entry.pending = filled

  shots.set(id, entry)
  evict()
  return id
}

/**
 * Картинка за QR-кодом из базы — когда её нет в памяти: сервер перезапускался
 * или вытеснил её при наплыве. Кладём обратно в память: страница стикера
 * берёт картинку дважды (показать и сохранить), второй раз база не нужна.
 */
async function restore(id) {
  if (!/^[\w-]{1,32}$/.test(id)) return null
  let saved
  try {
    saved = await loadQrImage(id)
  } catch (error) {
    console.error(`[qr] ${id}: из базы не достали:`, error?.message ?? error)
    return null
  }
  if (!saved) return null
  // QR, выданные до облегчения, лежат в базе тяжёлыми — ужимаем при доставании.
  const light = await lighten(saved.body, saved.type)
  // Пока ждали базу, ту же картинку мог достать параллельный запрос.
  const again = shots.get(id)
  if (again) return again
  const entry = { size: light.body.length, source: null, pending: Promise.resolve(light) }
  shots.set(id, entry)
  held += entry.size
  evict()
  // Страница снова открывается — нажатия на ней снова засчитываются.
  allowClicks(id)
  return entry
}

/**
 * QR-код ссылки для страницы статистики — как на экране панели: коррекция M,
 * поле в 3 модуля. Панель рисует библиотекой qrcode, здесь — qrcode-generator
 * без зависимостей: узор может отличаться, ссылка внутри та же.
 *
 * Подгружается, только когда открывают страницу QR: серверу панели
 * (`npm run sticker` в MAX_PO) библиотека не нужна, и её там нет.
 */
async function qrSvg(text) {
  try {
    const { default: qrcode } = await import('qrcode-generator')
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize: 8, margin: 24, scalable: true, title: 'QR-код' })
  } catch (error) {
    console.error('[qr] QR-код не нарисовался:', error?.message ?? error)
    return null
  }
}

/**
 * Маскота кладём прямо в страницу стикера — картинкой в разметке (data-URL).
 *
 * Раньше страница приходила с пустым кругом, а картинку догружал скрипт
 * отдельным запросом. На айфонах это работало, а на части Android-телефонов
 * круг оставался пустым: сканер QR открывает ссылку в своём браузере, где
 * скрипт может не отработать, второй запрос может застрять. Теперь маскот
 * приходит вместе со страницей и виден даже без скрипта; облегчённый весит
 * 40–80 КБ, страница от этого почти не толстеет.
 *
 * Картинки ещё нет (посетитель успел раньше панели) или она тяжёлая (сервер
 * без sharp) — отдаём страницу как раньше: скрипт догрузит сам.
 */
const INLINE_MAX = 400 * 1024
const EMPTY_FRAME = '<div class="inner" id="frame"><div class="spin"></div></div>'

async function withMascot(page, link) {
  const id = /^\/i\/([\w-]{1,32})$/.exec(link ?? '')?.[1]
  if (!id || !page.includes(EMPTY_FRAME)) return page
  const shot = shots.get(id) ?? await restore(id)
  if (!shot) return page
  let timer
  const ready = await Promise.race([
    shot.pending.then((value) => value, () => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), WAIT_FOR_COPY_MS) }),
  ])
  clearTimeout(timer)
  if (!ready || ready.body.length > INLINE_MAX || !/^image\/(jpeg|png|webp)$/.test(ready.type)) return page
  const img = `<img id="mascot" src="data:${ready.type};base64,${ready.body.toString('base64')}" alt="Ваш маскот">`
  return page.replace(EMPTY_FRAME, `<div class="inner" id="frame">${img}</div>`)
}

/**
 * Телефон и браузер одной строкой — для лога показов: «Android 14,
 * SamsungBrowser/27.0» или «iOS 18.5, Version/18.5». Последний токен —
 * встроенный браузер приложения, если он себя называет.
 */
function shortUa(ua = '') {
  const os = /Android [\d.]+/.exec(ua)?.[0]
    ?? (/iPhone|iPad/.test(ua) ? `iOS ${(/OS (\d+(?:_\d+)*)/.exec(ua)?.[1] ?? '').replace(/_/g, '.')}` : null)
    ?? /Windows|Mac OS X|Linux/.exec(ua)?.[0] ?? '?'
  // По старшинству, а не по месту в строке: во встроенных браузерах Android
  // впереди стоит ничего не говорящий «Version/4.0», а суть — дальше.
  const browser = BROWSERS.map((name) => new RegExp(`${name}/[\\d.]+`).exec(ua)?.[0]).find(Boolean) ?? '?'
  const app = ua.trim().split(' ').pop()
  const extra = /^(Safari|Mobile)\b/.test(app) || app.includes(browser.split('/')[0]) ? '' : `, ${app}`
  return `${os}, ${browser}${/; wv\)/.test(ua) ? ' webview' : ''}${extra}`.slice(0, 120)
}
const BROWSERS = ['SamsungBrowser', 'YaBrowser', 'MiuiBrowser', 'HuaweiBrowser', 'HeyTapBrowser', 'OPR', 'Firefox',
  'EdgA', 'CriOS', 'FxiOS', 'Chrome', 'Version']
/** Отчётов о показе с одной страницы — не больше (перезагрузки, вкладки). */
const VIEWS_PER_SHOT = 5
const views = new Map()

/**
 * Выбрасываем самые старые, пока не уложимся в оба предела.
 * Map хранит порядок вставки, поэтому первый ключ — самый давний.
 */
function evict() {
  // Последнюю запись не трогаем: даже если одна картинка не влезает в
  // бюджет целиком, выбрасывать её сразу после создания бессмысленно.
  while (shots.size > 1 && (shots.size > KEEP || held > BUDGET_BYTES)) {
    const oldest = shots.keys().next().value
    const shot = shots.get(oldest)
    shots.delete(oldest)
    held -= shot?.size ?? 0
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-kie-key',
    })
  }

  // Панель отдаёт ссылку на свежий результат, получает адрес для QR.
  if (req.method === 'POST' && url.pathname === '/shot') {
    if (SHOT_TOKEN && req.headers.authorization !== `Bearer ${SHOT_TOKEN}`) {
      return send(res, 401, JSON.stringify({ error: 'нужен токен' }), { 'content-type': 'application/json' })
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { url: source } = JSON.parse(Buffer.concat(chunks).toString())
      if (!source) return send(res, 400, JSON.stringify({ error: 'нет url' }))

      // Расширения в адресе нет намеренно: тип узнаётся только после
      // скачивания, а ответ нужен раньше. Тип отдаём заголовком.
      const id = keep(source)
      allowClicks(id)
      const file = `/i/${id}`
      const origin = publicOrigin()
      send(res, 200, JSON.stringify({
        id,
        // Адрес для QR. Некуда вести — отдаём null, и панель уходит на
        // запасной вариант: QR прямо на картинку у kie.ai.
        page: origin ? `${origin}/?i=${file}` : null,
        image: file,
      }), { 'content-type': 'application/json' })
    } catch (error) {
      send(res, 502, JSON.stringify({ error: String(error) }), { 'content-type': 'application/json' })
    }
    return
  }

  // Статистика генераций с панели — в MySQL, см. server/stats.mjs.
  // 503 — «пришли позже»: панель держит строки в очереди и повторит.
  if (req.method === 'POST' && url.pathname === '/stats/generations') {
    const json = { 'content-type': 'application/json' }
    if (SHOT_TOKEN && req.headers.authorization !== `Bearer ${SHOT_TOKEN}`) {
      return send(res, 401, JSON.stringify({ error: 'нужен токен' }), json)
    }
    if (!statsEnabled()) return send(res, 503, JSON.stringify({ error: 'статистика выключена: нет DB_HOST' }), json)

    let body
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        // 200 строк — это ~50 КБ; больше присылать незачем.
        if (size > 256 * 1024) return send(res, 413, JSON.stringify({ error: 'слишком много' }), json)
        chunks.push(chunk)
      }
      body = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      return send(res, 400, JSON.stringify({ error: 'нужен JSON { rows: [...] }' }), json)
    }

    const rows = cleanRows(body?.rows)
    try {
      const saved = await saveGenerations(rows)
      const total = Array.isArray(body?.rows) ? body.rows.length : 0
      return send(res, 200, JSON.stringify({ saved, duplicates: rows.length - saved, rejected: total - rows.length }), json)
    } catch {
      return send(res, 503, JSON.stringify({ error: 'база недоступна' }), json)
    }
  }

  /*
   * Нажатия на странице стикера: «Сохранить картинку» (save) и «Создать
   * стикер» — переход в бота (bot). Страница шлёт их через sendBeacon и
   * ответа не ждёт, поэтому отвечаем сразу, а в базу пишем фоном.
   *
   * Адрес открыт всем — нажимают посетители со своих телефонов. Чтобы
   * счётчик не накрутили, засчитываем только картинки, которые сервер сам
   * выдал панели, и не больше CLICKS_PER_SHOT нажатий кнопки на картинку.
   * Остальное молча пропускаем: ответ одинаковый, подбирать нечего.
   */
  if (req.method === 'POST' && url.pathname === '/stats/click') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 512) return send(res, 413, '')
      chunks.push(chunk)
    }
    let click = null
    try {
      click = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      // не JSON — не засчитываем
    }
    const button = click?.button
    const counts = typeof click?.shot === 'string' ? clickable.get(click.shot) : undefined
    if (counts && (button === 'save' || button === 'bot') && counts[button] < CLICKS_PER_SHOT) {
      counts[button] += 1
      recordClick(button, click.shot)
    }
    return send(res, 204, '')
  }

  /*
   * Страница стикера сообщает, показался ли маскот и за сколько, — чтобы
   * видеть, на каких телефонах и в каких браузерах он не показывается.
   * Только в лог, без IP и без базы: «[страница] 2dafbc4c74ae Android 14,
   * SamsungBrowser/27.0: показан за 412 мс, в странице».
   */
  if (req.method === 'POST' && url.pathname === '/stats/view') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 512) return send(res, 413, '')
      chunks.push(chunk)
    }
    let view = null
    try {
      view = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      // не JSON — молча мимо
    }
    const shot = typeof view?.shot === 'string' ? view.shot : ''
    const seen = views.get(shot) ?? 0
    if (clickable.has(shot) && seen < VIEWS_PER_SHOT) {
      views.set(shot, seen + 1)
      if (views.size > CLICKABLE_KEEP) views.delete(views.keys().next().value)
      const ms = Math.max(0, Math.round(Number(view.ms) || 0))
      const box = /^\d{1,5}x\d{1,5}$/.test(view.box ?? '') ? `, круг ${view.box}` : ''
      // На Android маскот рисуется на холсте; px — цвет его середины
      // (0,0,0 — чёрный круг), gpu — видеочип телефона.
      const canvas = view.mode === 'canvas'
        ? `, холст${/^\d{1,3},\d{1,3},\d{1,3}$/.test(view.px ?? '') ? ` (середина ${view.px})` : ''}` : ''
      const gpu = typeof view.gpu === 'string' && view.gpu
        ? `, видеочип ${view.gpu.replace(/[^\w ().,:/+-]/g, '').slice(0, 80)}` : ''
      console.log(`[страница] ${shot} ${shortUa(req.headers['user-agent'])}: ` +
        (view.shown ? `показан за ${ms} мс` : `НЕ показан за ${ms} мс`) +
        (view.inline ? ', в странице' : ', отдельным запросом') + box + canvas + gpu)
    }
    return send(res, 204, '')
  }

  // Страница статистики и выгрузка CSV — под паролем STATS_PASSWORD,
  // см. server/statspage.mjs.
  const statsPaths = ['/stats', '/stats.csv', '/stats/login', '/stats/logout']
  // Страница одного QR-кода: сам QR, картинка и ссылка.
  const qrPage = /^\/stats\/qr\/([\w-]{1,32})$/.exec(url.pathname)
  if ((statsPaths.includes(url.pathname) || qrPage) && (req.method === 'GET' || url.pathname === '/stats/login')) {
    const text = { 'content-type': 'text/plain; charset=utf-8' }
    if (!statsPageEnabled()) return send(res, 404, 'страница статистики выключена: не задан STATS_PASSWORD', text)
    const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }

    if (url.pathname === '/stats/login') {
      if (req.method !== 'POST') return send(res, 303, '', { location: '/stats' })
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 2048) return send(res, 413, 'слишком длинно', text)
        chunks.push(chunk)
      }
      const password = new URLSearchParams(Buffer.concat(chunks).toString()).get('password')
      if (!(await passwordOk(password))) return send(res, 401, renderSignIn('Неверный пароль'), html)
      return send(res, 303, '', { location: '/stats', 'set-cookie': signInCookie(req) })
    }
    if (url.pathname === '/stats/logout') {
      return send(res, 303, '', { location: '/stats', 'set-cookie': SIGN_OUT_COOKIE })
    }
    if (!signedIn(req)) {
      return url.pathname === '/stats' ? send(res, 401, renderSignIn(), html) : send(res, 303, '', { location: '/stats' })
    }

    if (!statsEnabled()) return send(res, 503, renderUnavailable(statsState()), html)
    try {
      if (qrPage) {
        const qr = await readQrCode(qrPage[1])
        if (!qr) return send(res, 404, renderQrMissing(), html)
        // Ссылка — ровно та, что была в QR на панели (её собирает /shot).
        const link = `${publicOrigin() ?? `http://${req.headers.host}`}/?i=/i/${qr.id}`
        return send(res, 200, renderQrPage(qr, link, await qrSvg(link)), html)
      }
      if (url.pathname === '/stats.csv') {
        return send(res, 200, renderCsv(await allGenerations()), {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="generations.csv"',
        })
      }
      return send(res, 200, renderStats(await readStats()), html)
    } catch (error) {
      console.error('[статистика] страница:', error?.message ?? error)
      return send(res, 503, renderUnavailable(`${statsState()}, подробности в логе сервера`), html)
    }
  }

  // Проверка живости — для Dokploy и любого монитора.
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({
      ok: true,
      shots: shots.size,
      heldMb: Math.round(held / 1024 / 1024),
      budgetMb: Math.round(BUDGET_BYTES / 1024 / 1024),
      // База статистики: ok, выключена или нет связи. На живость сервера не
      // влияет — страница и QR без базы работают.
      stats: statsState(),
      // Облегчение картинок для телефона (lighten.mjs): включено или нет sharp.
      light: lightenState(),
      // Последние скачивания: сразу видно, кто тормозит на реальном трафике.
      timings,
    }),
      { 'content-type': 'application/json' })
  }

  /**
   * Панель кладёт сюда снятый кадр и получает публичную ссылку на него.
   *
   * Нужен потому, что хранилище kie.ai (kieai.redpandaai.co) с панели
   * недоступно — судя по всему, режется провайдером. Это самый первый шаг
   * генерации, без него не работает вообще ничего. Наш домен панель видит,
   * а kie.ai умеет скачать картинку по любой публичной ссылке.
   */
  if (req.method === 'POST' && url.pathname === '/upload') {
    if (SHOT_TOKEN && req.headers.authorization !== `Bearer ${SHOT_TOKEN}`) {
      return send(res, 401, JSON.stringify({ error: 'нужен токен' }), { 'content-type': 'application/json' })
    }
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        // Кадр с камеры весит сотни килобайт; всё, что сильно больше, —
        // не наш случай, и память под это отдавать незачем.
        if (size > MAX_UPLOAD) return send(res, 413, JSON.stringify({ error: 'слишком большой файл' }),
          { 'content-type': 'application/json' })
        chunks.push(chunk)
      }

      const { dataUrl } = JSON.parse(Buffer.concat(chunks).toString())
      const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl ?? '')
      if (!match) return send(res, 400, JSON.stringify({ error: 'нужен dataUrl' }),
        { 'content-type': 'application/json' })

      const type = match[1]
      const id = store(Buffer.from(match[2], 'base64'), type)
      const file = `/i/${id}.${EXT[type] ?? 'jpg'}`
      // Ссылку отдаём, только если сервер публичный. Локальный адрес вида
      // http://192.168.x.x:8787 kie.ai из интернета не скачает, и генерация
      // встала бы на первом шаге. На `null` панель грузит кадр в хранилище
      // kie.ai сама — так и было до появления этого маршрута.
      send(res, 200, JSON.stringify({ url: PUBLIC_URL ? `${PUBLIC_URL}${file}` : null, image: file }),
        { 'content-type': 'application/json' })
    } catch (error) {
      send(res, 400, JSON.stringify({ error: String(error) }), { 'content-type': 'application/json' })
    }
    return
  }

  /**
   * Прокси к API kie.ai: панель зовёт нас, наружу ходим мы.
   *
   * Зачем. Из трёх доменов kie.ai два с панели недоступны — хранилище кадров
   * и хост результатов; их обход уже сделан. Оставался третий, сам API: пока
   * он открыт, всё работает, а закроют — встанет всё и делать будет нечего.
   * С этим маршрутом у панели наружу остаётся ровно один адрес: наш домен.
   *
   * Ключ kie.ai сервер не хранит и не подставляет — панель присылает его
   * в `x-kie-key`. Иначе эндпоинт стал бы бесплатным генератором картинок
   * для всякого, кто узнает адрес.
   */
  if (url.pathname.startsWith('/kie/')) {
    if (SHOT_TOKEN && req.headers.authorization !== `Bearer ${SHOT_TOKEN}`) {
      return send(res, 401, JSON.stringify({ error: 'нужен токен' }), { 'content-type': 'application/json' })
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)

      const upstream = await fetch(`https://api.kie.ai/${url.pathname.slice(5)}${url.search}`, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(req.headers['x-kie-key'] ? { authorization: `Bearer ${req.headers['x-kie-key']}` } : {}),
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })

      send(res, upstream.status, Buffer.from(await upstream.arrayBuffer()),
        { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    } catch (error) {
      send(res, 502, JSON.stringify({ error: String(error) }), { 'content-type': 'application/json' })
    }
    return
  }

  /*
   * Панель кладёт сюда свою копию картинки.
   *
   * Она скачала её у kie.ai для показа на экране, так что байты у неё уже
   * есть. Пока мы качаем тот же файл второй раз, эти байты просто лежат.
   * Кто дойдёт первым, тот запись и заполнит: если наш канал до kie.ai
   * медленный или хост недоступен, копия придёт с панели, и телефону не
   * придётся ждать вовсе.
   *
   * Вызывается фоном, уже после показа экрана результата, поэтому на
   * скорость появления QR не влияет.
   */
  if (req.method === 'POST' && url.pathname.startsWith('/i/')) {
    if (SHOT_TOKEN && req.headers.authorization !== `Bearer ${SHOT_TOKEN}`) {
      return send(res, 401, JSON.stringify({ error: 'нужен токен' }), { 'content-type': 'application/json' })
    }
    const shot = shots.get(url.pathname.slice(3).replace(/\.[a-z0-9]+$/i, ''))
    if (!shot?.fill) return send(res, 404, JSON.stringify({ error: 'нет такой картинки' }),
      { 'content-type': 'application/json' })
    // Уже заполнена — панель опоздала, и это нормально: значит, мы успели сами.
    if (shot.filled) return send(res, 200, JSON.stringify({ filled: 'уже' }),
      { 'content-type': 'application/json' })

    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_UPLOAD) return send(res, 413, JSON.stringify({ error: 'слишком большой файл' }),
          { 'content-type': 'application/json' })
        chunks.push(chunk)
      }
      const { dataUrl } = JSON.parse(Buffer.concat(chunks).toString())
      const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl ?? '')
      if (!match) return send(res, 400, JSON.stringify({ error: 'нужен dataUrl' }),
        { 'content-type': 'application/json' })

      const filled = shot.fill(Buffer.from(match[2], 'base64'), match[1], 'прислала панель')
      return send(res, 200, JSON.stringify({ filled: filled ? 'да' : 'уже' }),
        { 'content-type': 'application/json' })
    } catch (error) {
      return send(res, 400, JSON.stringify({ error: String(error) }), { 'content-type': 'application/json' })
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/i/')) {
    // Расширение в адресе не обязательно, но и не мешает — отрезаем.
    const id = url.pathname.slice(3).replace(/\.[a-z0-9]+$/i, '')
    // Нет в памяти — сервер перезапускался или картинку вытеснили: берём из базы.
    const shot = shots.get(id) ?? await restore(id)
    if (!shot) return send(res, 404, 'нет такой картинки')

    /*
     * Посетитель мог отсканировать код раньше, чем мы докачали картинку.
     * Ждём — но с пределом: раньше здесь стояло голое `await shot.pending`,
     * и телефон висел ровно столько, сколько kie.ai отдавал файл нам. Если
     * тот хост подвисал, ожидание не кончалось никогда.
     *
     * Не дождались или скачать не вышло — отправляем к первоисточнику.
     * Ссылка у нас есть, и картинка оттуда откроется быстрее, чем мы её
     * перекачаем. Фоновое скачивание при этом продолжается: следующий
     * запрос того же id уже получит нашу копию.
     */
    const askedAt = Date.now()
    let timer
    const ready = await Promise.race([
      shot.pending.then((value) => value, () => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), WAIT_FOR_COPY_MS) }),
    ])
    clearTimeout(timer)
    const waited = Date.now() - askedAt
    // Ждал ли телефон вообще — главный вопрос всей этой истории.
    if (waited > 50) note({ kind: ready ? 'телефон ждал копию' : 'телефон ушёл к kie.ai', ms: waited })

    if (!ready) {
      if (shot.source) return send(res, 302, '', { location: shot.source })
      return send(res, 504, 'картинку скачать не удалось')
    }
    const { body, type } = ready

    // inline, а не attachment: если посетитель дойдёт до картинки напрямую,
    // она должна открыться, а не скачаться файлом.
    return send(res, 200, body, {
      'content-type': type,
      'content-disposition': 'inline',
      'cache-control': 'public, max-age=3600',
    })
  }

  // Статика страницы: шрифт VK Sans Display (/fonts/) — без него телефон
  // подставит системный — и значок MAX для сохраняемой картинки (/img/).
  // Имя файла — только буквы, цифры и дефис: выйти за пределы sticker/fonts
  // и sticker/img нельзя.
  const asset = req.method === 'GET' && url.pathname.match(/^\/(fonts|img)\/([\w-]+)\.(woff2|png)$/)
  if (asset) {
    const [, dir, name, ext] = asset
    try {
      return send(res, 200, await readFile(join(ROOT, 'sticker', dir, `${name}.${ext}`)), {
        'content-type': ext === 'png' ? 'image/png' : 'font/woff2',
        // Шрифты не меняются — сутки в кэше. Картинку браузер перепроверяет
        // при каждой загрузке: заменили значок — телефон сразу берёт новый,
        // а не сутки рисует старый из кэша.
        'cache-control': ext === 'png' ? 'no-cache' : 'public, max-age=86400',
      })
    } catch {
      return send(res, 404, 'не найдено')
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    let page
    try {
      page = await readFile(PAGE, 'utf8')
    } catch {
      return send(res, 500, 'страница не найдена: ' + PAGE)
    }
    return send(res, 200, await withMascot(page, url.searchParams.get('i')), {
      'content-type': 'text/html; charset=utf-8',
      // Страница своя у каждого QR и с картинкой внутри — не кэшируем.
      'cache-control': 'no-store',
    })
  }

  send(res, 404, 'не найдено')
})

startStats()

server.listen(PORT, '0.0.0.0', () => {
  const origin = publicOrigin()
  console.log(`Страница стикера: ${origin ?? `http://localhost:${PORT}`}`)
  if (!origin) console.log('Сети не видно — телефон до панели не достучится.')
  if (PUBLIC_URL && !SHOT_TOKEN) {
    console.log('ВНИМАНИЕ: PUBLIC_URL задан, а SHOT_TOKEN — нет.')
    console.log('POST /shot открыт всему интернету: любой заставит сервер качать что угодно.')
  }
})
