FROM node:20-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/openclaw/package.json packages/adapters/openclaw/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r build
RUN rm -rf server/ui-dist && cp -r ui/dist server/ui-dist
RUN pnpm --filter @paperclipai/server deploy --prod /prod/server
RUN node -e "const fs=require('node:fs'); const path=require('node:path'); const root='/prod/server/node_modules/@paperclipai'; const pkgs=fs.existsSync(root)?fs.readdirSync(root):[]; const rewrite=(v)=>typeof v==='string'?v.replace(/\\.\\/src\\//g,'./dist/').replace(/\\.ts$/g,'.js'):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,val])=>[k,rewrite(val)])):v; for (const name of pkgs){ const pkgJson=path.join(root,name,'package.json'); if(!fs.existsSync(pkgJson)) continue; const pkg=JSON.parse(fs.readFileSync(pkgJson,'utf8')); if(pkg.exports) pkg.exports=rewrite(pkg.exports); if(typeof pkg.main==='string') pkg.main=pkg.main.replace(/\\.\\/src\\//g,'./dist/').replace(/\\.ts$/g,'.js'); if(typeof pkg.module==='string') pkg.module=pkg.module.replace(/\\.\\/src\\//g,'./dist/').replace(/\\.ts$/g,'.js'); fs.writeFileSync(pkgJson, JSON.stringify(pkg,null,2)); }"

FROM base AS development
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest

ENV NODE_ENV=development \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_UI_DEV_MIDDLEWARE=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

VOLUME ["/paperclip"]
EXPOSE 3100

CMD ["pnpm", "--filter", "@paperclipai/server", "dev"]

FROM base AS production
WORKDIR /app
COPY --from=build /prod/server /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_UI_DEV_MIDDLEWARE=false \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

VOLUME ["/paperclip"]
EXPOSE 3100

CMD ["node", "dist/index.js"]
