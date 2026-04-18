FROM node:22-alpine

WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node server.mjs .

EXPOSE 8787

CMD ["node", "server.mjs"]
