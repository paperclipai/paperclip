# TOOLS — Dev Full Stack

Ferramentas:
- Node.js / pnpm
- Next.js (App Router)
- PocketBase SDK
- N8N (web UI)
- Docker Compose
- Playwright, Vitest, Semgrep

Comandos rápidos:
- `pnpm install`
- `pnpm dev`
- `pnpm test` (unit)
- `pnpm test:e2e` (Playwright)
- `node infra/pocketbase/migrations/002_omnichannel.js`
- `docker compose up -d pocketbase n8n openclaw ollama`

Env/Vars importantes:
- `NEXT_PUBLIC_POCKETBASE_URL`, `POCKETBASE_ADMIN_EMAIL`, `POCKETBASE_ADMIN_PASSWORD`, `N8N_COTACOES_WEBHOOK_URL`, `WHATSAPP_PHONE_NUMBER_ID`.
