FROM node:22-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

RUN addgroup -S 1000 app && adduser -S -G app -u 1000 app
USER app

EXPOSE 8787
CMD ["node", "/app/server.mjs"]
