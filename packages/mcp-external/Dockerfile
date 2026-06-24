# syntax=docker/dockerfile:1
#
# @paperclipai/mcp-external — Node build of the Paperclip external MCP server.
# This is the drop-in replacement for the Python `paperclip-mcp` *server*
# container (the one on :9011 behind the bun auth-proxy sidecar in
# onprem-k8s/paperclip/paperclip-mcp.yaml). The auth-proxy is unchanged.
#
# mcp-external is fully standalone (no `@paperclipai/*` / `workspace:` deps — only
# the public @modelcontextprotocol/sdk + zod), so it builds in isolation without
# the full monorepo / pnpm workspace install. Build context = the paperclip repo
# root, because the package tsconfig extends ../../tsconfig.base.json.
#
#   docker build -f packages/mcp-external/Dockerfile -t paperclip-mcp-external .
#
# Env contract (drop-in with the Python server's paperclip-mcp-credentials
# secret): PAPERCLIP_BASE_URL (or PAPERCLIP_API_URL), optional PAPERCLIP_API_KEY,
# PAPERCLIP_COMPANY_ID. Listens on MCP_HOST:MCP_PORT (default 0.0.0.0:9011) /mcp.

ARG BASE=harbor.blockcast.net/paperclip/node:lts-trixie-slim

# ---- build: compile dist/http.js (needs devDeps: typescript, @types/node) ----
FROM ${BASE} AS build
WORKDIR /build
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/mcp-external/package.json packages/mcp-external/tsconfig.json ./packages/mcp-external/
WORKDIR /build/packages/mcp-external
RUN npm install --no-audit --no-fund
COPY packages/mcp-external/src ./src
RUN npm run build && test -f dist/http.js

# ---- runtime: dist + prod deps only; non-root, read-only-root friendly ----
FROM ${BASE} AS runtime
ENV NODE_ENV=production \
    HOME=/tmp \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=9011
WORKDIR /app
COPY packages/mcp-external/package.json ./package.json
COPY --from=build /build/packages/mcp-external/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
USER 1000
EXPOSE 9011
ENTRYPOINT ["node", "dist/http.js"]
