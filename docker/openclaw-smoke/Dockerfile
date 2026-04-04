FROM node:22-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 8787

USER node

CMD ["node", "/app/server.mjs"]
