# emisso-os

AI Operating System for Emisso — forked from [Paperclip](https://github.com/paperclipai/paperclip).

## What This Is

Control plane for orchestrating AI agents across two domains:
1. **Emisso** — AI-native software factory delivering client projects with engineering agents
2. **emisso-creator** — personal brand content engine turning shipped work into content

## Architecture

- **Fork of Paperclip** — 55+ tables, agent orchestration, heartbeats, budgets, governance
- **Separate Postgres** — does NOT share Supabase with emisso-app (incompatible isolation models)
- **Bridge auth** — Supabase JWT → Better Auth session via `/auth/bridge`
- **`emisso_tenant_map`** — maps Paperclip `companyId` ↔ Emisso `tenantId`

## Repo Structure

```
emisso-os/
├── server/              ← Express API + WebSocket realtime
├── ui/                  ← React SPA (Vite) — rebranded Paperclip board
├── cli/                 ← CLI for setup
├── packages/
│   ├── db/              ← Drizzle schema, migrations, embedded PGlite for dev
│   ├── shared/          ← Types, constants, validators
│   ├── adapter-utils/   ← Billing, session compaction, log redaction
│   ├── adapters/
│   │   ├── claude-local/       ← Primary agent runtime
│   │   ├── openclaw-gateway/   ← Keep for evaluation
│   │   ├── codex-local/        ← DEPRECATED — remove in Phase 1
│   │   ├── cursor-local/       ← DEPRECATED — remove in Phase 1
│   │   ├── gemini-local/       ← DEPRECATED — remove in Phase 1
│   │   ├── opencode-local/     ← DEPRECATED — remove in Phase 1
│   │   └── pi-local/           ← DEPRECATED — remove in Phase 1
│   └── plugins/
│       ├── sdk/                ← Plugin SDK
│       └── create-paperclip-plugin/  ← Plugin scaffolding
├── doc/                 ← Paperclip operational docs
└── docs/                ← Mintlify docs (to be replaced)
```

## Commands

```bash
pnpm install             # Install dependencies
pnpm build               # Build all packages
pnpm dev                 # Start dev server (embedded PGlite, no DATABASE_URL needed)
pnpm -r typecheck        # Typecheck all packages
pnpm test:run            # Run tests
```

## Key Concepts (from Paperclip)

- **Companies** — isolated tenants (we have two: "Emisso" factory + "emisso-creator")
- **Agents** — autonomous workers with heartbeats, budgets, and org-chart hierarchy
- **Issues** — work units assigned to agents, with checkout semantics
- **Heartbeats** — periodic agent check-ins (timer, assignment, automation triggers)
- **Governance** — approval gates, budget caps, auto-pause at limits
- **Adapters** — runtime backends (claude-local is our primary)
- **Plugins** — extend the board UI and server with custom functionality

## Upstream

- Forked from `paperclipai/paperclip` at commit `a290d1d5` (2026-03-20)
- `upstream` remote tracks the original repo
- See `UPSTREAM_CHANGELOG.md` for sync history
- **Rule:** Never modify Paperclip's shared types in-place — extend them

## Integration with Emisso App

- emisso-app (Supabase + Next.js) ↔ emisso-os (Express + own Postgres)
- Communication: REST/webhooks + shared identifiers (GitHub repo slugs, project IDs)
- No shared database tables, no circular dependencies
- Data flows documented in emisso-hq planning docs

## What NOT to Do

1. Don't merge emisso-os tables into Supabase
2. Don't rewrite Paperclip's existing UI — rebrand + extend with plugins
3. Don't create circular deps between emisso-app and emisso-os
4. Don't modify Paperclip core types in-place — extend them
