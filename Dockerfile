# Сервер страницы стикера MAX.
#
# Зависимостей три: mysql2 — драйвер базы для статистики (server/stats.mjs),
# qrcode-generator — QR-коды на странице статистики, без своих зависимостей, и
# sharp — ужимает картинку маскота для телефона (server/lighten.mjs). Сборку
# libvips под alpine (linuxmusl-x64) sharp ставит готовой, компилировать нечего.
# Остальное написано на встроенных модулях Node.
FROM node:22-alpine

WORKDIR /app

# Сначала только манифесты: слой с node_modules пересобирается, лишь когда
# меняются зависимости, а не при каждой правке страницы.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Только то, что сервер читает: сам себя и страницу со шрифтами.
COPY server/ ./server/
COPY sticker/ ./sticker/

# Внутри контейнера порт фиксирован; домен на него направляет Dokploy.
ENV PORT=8787
EXPOSE 8787

# Не от root: контейнеру достаточно прав на чтение своих же файлов.
USER node

# По этой проверке Dokploy (Docker Swarm) понимает, что новая версия
# поднялась, и только тогда гасит старую. wget есть в образе alpine.
# База статистики на проверку не влияет: без неё страница работает.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server/index.mjs"]
