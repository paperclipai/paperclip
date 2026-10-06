# Build from the repository root:
#   docker build -f packages/mcp-connector/Dockerfile -t paperclip-mcp-connector .
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
# CI owns pnpm-lock.yaml (PRs may not commit it), so a checkout taken before the
# post-merge lockfile refresh can be stale for this package. Resolve it inline
# the same way the PR lanes do, then install from the resolved lockfile.
RUN if ! pnpm install --frozen-lockfile --ignore-scripts --filter "@paperclipai/mcp-connector..."; then \
      echo "pnpm-lock.yaml is stale for this checkout; resolving it inline" >&2 \
      && pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile \
      && pnpm install --frozen-lockfile --ignore-scripts --filter "@paperclipai/mcp-connector..."; \
    fi \
  && pnpm --filter @paperclipai/mcp-connector build \
  && pnpm --filter @paperclipai/mcp-connector deploy --prod --ignore-scripts /out

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE=/data/credentials.json
# Carry only the lockfile-resolved runtime package and its dependencies.
COPY --from=build /out/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["run"]
