/**
 * Облегчённая копия маскота — её получает телефон и её же хранит база.
 *
 * Модели kie.ai отдают 2048 × 2048 JPEG на 1,1–1,5 МБ, вырезка фона — PNG
 * на ~3 МБ. Телефону столько не нужно: круг на странице меньше 600 точек,
 * а сохраняемая картинка — 1080 × 1080. Лишние мегабайты ещё и застревают по
 * дороге: на замерах 19 ноября примерно каждая десятая отдача файла в 1–2 МБ
 * с нашего сервера шла 15–25 секунд, а то и вставала совсем, — и посетитель
 * видел на странице пустой круг. Чем меньше файл, тем реже он застревает.
 *
 * Короткая сторона — 1080, длинная — по пропорции; меньшие не увеличиваем.
 * Прозрачное — на чёрный, а потом lighten с цветом круга: максимум по каждому
 * каналу, и чёрный фон маскота становится цветом круга прямо в файле. Раньше
 * это смешивание делала страница (mix-blend-mode), и на части Android-
 * телефонов картинка в круге не рисовалась вовсе. JPEG — а не WebP: его
 * открывает любой телефон, в том числе старый айфон.
 *
 * sharp необязателен: на панели (`npm run sticker` в MAX_PO) его нет, и тогда
 * картинки идут как есть — как было до облегчения.
 */
const SIDE = 1080
const QUALITY = 85
/** Фон круга на странице и на панели — rgb(12, 1, 25). */
const CIRCLE = { r: 12, g: 1, b: 25 }
/**
 * Метка обработанной картинки (в EXIF). Есть — картинку уже ужимали этой
 * версией, второй раз пережимать незачем: только потеряем в качестве.
 */
const MARK = 'max-mascot light 2'

/** Модуль sharp или null, если его нет. Грузим один раз, при старте. */
const sharpReady = import('sharp')
  .then(({ default: sharp }) => {
    // Каждая картинка ужимается один раз — кэш libvips только держал бы память.
    sharp.cache(false)
    return sharp
  })
  .catch((error) => {
    console.warn('[облегчение] sharp не загрузился — картинки идут как есть:', error?.message ?? error)
    return null
  })

let available = null
void sharpReady.then((sharp) => { available = Boolean(sharp) })

/** Для /health: работает ли облегчение. */
export function lightenState() {
  if (available === null) return 'проверяем'
  return available ? 'включено' : 'нет sharp — картинки как есть'
}

/**
 * { body, type } → облегчённые { body, type }. Не бросает: что бы ни случилось,
 * в худшем случае вернёт исходник — картинка должна дойти хоть какой-то.
 */
export async function lighten(body, type) {
  const sharp = await sharpReady
  if (!sharp) return { body, type }
  try {
    const { exif } = await sharp(body).metadata()
    if (exif?.includes(MARK)) return { body, type }

    const light = await sharp(body)
      .resize({ width: SIDE, height: SIDE, fit: 'outside', withoutEnlargement: true })
      .flatten({ background: '#000000' })
      .composite([{ input: { create: { width: 8, height: 8, channels: 3, background: CIRCLE } }, tile: true, blend: 'lighten' }])
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .withExif({ IFD0: { Software: MARK } })
      .toBuffer()
    return { body: light, type: 'image/jpeg' }
  } catch (error) {
    console.warn('[облегчение] не вышло, отдаём как есть:', error?.message ?? error)
    return { body, type }
  }
}
