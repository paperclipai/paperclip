# syntax=docker/dockerfile:1
#
# paperclip-mcp-gateway: thin reverse-proxy that catches "Session not
# found" 404s from upstream MCP servers and replays the cached
# `initialize` request before retrying. Single-binary Node service,
# no external dependencies at runtime — uses native node:http + fetch.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY packages/mcp-gateway ./packages/mcp-gateway
COPY tsconfig.base.json ./
RUN cd packages/mcp-gateway && pnpm install --frozen-lockfile=false --prod=false
RUN cd packages/mcp-gateway && pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/mcp-gateway/dist ./dist
COPY --from=build /app/packages/mcp-gateway/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
