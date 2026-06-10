# Architecture — Paperclip

## Project Purpose
Paperclip is an open-source AI agent orchestration platform. It manages teams of AI agents (OpenClaw, Claude, Codex, Cursor) as a virtual company with org charts, budgets, goals, and governance.

## Tech Stack
- **Runtime**: Node.js 20+ (ESM)
- **Package Manager**: pnpm 9.15.4
- **UI**: React 19 + TypeScript + Tailwind CSS
- **Server**: Fastify/Node.js with tRPC
- **Database**: Embedded PostgreSQL 18.1.0-beta.16 (patched, isolated instance)
- **Queue**: BullMQ + Redis
- **Build**: esbuild + TypeScript

## Monorepo Structure
```
packages/           # Shared packages (SDK, types, config)
server/             # Backend (Fastify, tRPC, DB)
  src/
    db/             # Drizzle ORM schema + migrations
    api/            # tRPC routers
    agents/         # Agent heartbeat orchestration
    plugins/        # Plugin system
ui/                 # React frontend (Vite)
  src/
    components/     # UI components
    pages/          # Route pages
    hooks/          # React hooks
cli/                # CLI tool (Node.js)
docs/               # Mintlify documentation
scripts/            # Build, release, dev scripts
evals/              # Prompt evaluation suite
```

## Data Flow
```
User → React UI → tRPC → Fastify Server → Drizzle ORM → PostgreSQL
                                          ↓
                                    BullMQ + Redis
                                          ↓
                                    Agent Heartbeats
```

## Database
- **Instance**: Isolated embedded PostgreSQL (port 54329)
- **ORM**: Drizzle
- **Migrations**: Managed via `pnpm db:migrate`
- **Schema**: Organizations, agents, goals, tasks, sessions, messages

## External APIs
- **Claude / Anthropic** — AI agent inference
- **OpenAI** — GPT/Codex agent inference
- **Discord** — Alerts and digests (webhooks)
- **GitHub** — Repository integration

## Authentication/Authorization
- Session-based auth (cookie)
- JWT for API access
- Role-based: owner, admin, member

## Ports
| Port | Purpose | Access |
|------|---------|--------|
| 3100 | Paperclip HTTP | localhost only |
| 3443 | Paperclip HTTPS | Tailscale (Caddy) |
| 54329 | PostgreSQL | localhost only |
