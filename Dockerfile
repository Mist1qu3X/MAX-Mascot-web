# Сервер страницы стикера MAX.
#
# Зависимостей нет: server/index.mjs написан на встроенных модулях Node,
# поэтому ни npm install, ни node_modules в образе не нужны.
FROM node:22-alpine

WORKDIR /app

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server/index.mjs"]
