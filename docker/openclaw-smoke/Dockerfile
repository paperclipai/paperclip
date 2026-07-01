FROM node:22-alpine

RUN addgroup -S smoke && adduser -S smoke -G smoke

WORKDIR /app
RUN chown smoke:smoke /app
COPY --chown=smoke:smoke server.mjs /app/server.mjs

USER smoke

EXPOSE 8787

CMD ["node", "/app/server.mjs"]
