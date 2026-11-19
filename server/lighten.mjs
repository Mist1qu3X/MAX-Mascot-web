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
 * Прозрачное — на чёрный: страница и сохраняемая картинка кладут маскота
 * через lighten, и чёрный фон становится цветом круга, как у обычных кадров.
 * JPEG — а не WebP: его открывает любой телефон, в том числе старый айфон.
 *
 * sharp необязателен: на панели (`npm run sticker` в MAX_PO) его нет, и тогда
 * картинки идут как есть — как было до облегчения.
 */
const SIDE = 1080
const QUALITY = 85

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
    const { width = 0, height = 0, format } = await sharp(body).metadata()
    // Уже лёгкая (JPEG не крупнее нужного) — пережимать незачем: только
    // потеряем в качестве. Так бывает с тем, что уже ужимали.
    if (format === 'jpeg' && Math.min(width, height) <= SIDE) return { body, type }

    const light = await sharp(body)
      .resize({ width: SIDE, height: SIDE, fit: 'outside', withoutEnlargement: true })
      .flatten({ background: '#000000' })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
    return light.length < body.length ? { body: light, type: 'image/jpeg' } : { body, type }
  } catch (error) {
    console.warn('[облегчение] не вышло, отдаём как есть:', error?.message ?? error)
    return { body, type }
  }
}
