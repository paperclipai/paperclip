# CLAUDE.md

Paperclip = open-source control plane for autonomous AI companies. Node.js server + React UI. Orchestrates agent teams with org charts, tasks, budgets, heartbeats, governance.

## Repo

| Path | What |
|------|------|
| `server/src/routes/` | Express REST API endpoints |
| `server/src/services/` | Business logic |
| `ui/src/pages/` | React 19 + Tailwind v4 + shadcn/ui operator UI |
| `packages/db/src/schema/` | Drizzle ORM tables (PostgreSQL) |
| `packages/shared/` | Shared TS types, constants, validators |
| `packages/adapters/` | Agent adapters: claude-local, codex-local, cursor-local, pi-local, gemini-local, opencode-local, openclaw-gateway |
| `packages/adapter-utils/` | Shared adapter utilities |
| `skills/` | Runtime-injected agent skills (paperclip, create-agent, create-plugin, para-memory) |
| `cli/` | `paperclipai` CLI |
| `doc/` | Product/ops docs |

## Commands

```sh
pnpm dev                  # Server + UI at http://localhost:3100 (embedded Postgres auto-starts)
pnpm build                # Build all
pnpm -r typecheck         # TS check all packages
pnpm test:run             # Vitest
pnpm test:e2e             # Playwright E2E
pnpm db:generate          # Generate migration after schema edits
pnpm paperclipai doctor   # Health check (--repair to fix)
```

Data: `~/.paperclip/instances/default/db/`. Reset: `rm -rf` that dir + `pnpm dev`.

## Stack

Node.js 20+, Express, TypeScript (ES2023/NodeNext), Drizzle ORM, React 19, Vite, Tailwind v4, shadcn/ui, Radix, PGlite (dev) / Postgres (prod), pnpm 9.15+, Vitest, Playwright.

## Rules

1. **Company-scoped.** Every entity belongs to a company. Enforce boundaries in routes/services.
2. **Sync layers.** Schema change -> update `packages/db` -> `packages/shared` -> `server` -> `ui`.
3. **Invariants.** Single-assignee tasks, atomic checkout, approval gates, budget hard-stop, activity logging.
4. **Auth.** Operator = full control. Agents = bearer API keys (hashed, company-scoped). Errors: 400/401/403/404/409/422/500.
5. **DB changes.** Edit schema -> export from index.ts -> `pnpm db:generate` -> `pnpm -r typecheck`.
6. **Modes.** `local_trusted` (loopback, no login) | `authenticated/private` (LAN/Tailscale) | `authenticated/public` (internet).
7. **No lockfile commits.** CI owns `pnpm-lock.yaml`.
8. **`gh` needs `--repo adacovsk/paperclip`.** `origin` here is `adacovsk/paperclip`, but bare `gh` (`gh pr create`/`merge`/`repo view`) resolves this dir to `paperclipai/paperclip` and fails with `No commits between master and <branch>`. Always pass `--repo adacovsk/paperclip` explicitly; default branch is `master`.

## Done When

`pnpm -r typecheck && pnpm test:run && pnpm build` all pass. Contracts synced across all layers. Docs updated if behavior changed.

## Docs

| Doc | Purpose |
|-----|---------|
| `doc/SPEC-implementation.md` | V1 build contract (authoritative) |
| `doc/PRODUCT.md` | Core concepts, design goals |
| `doc/GOAL.md` | Vision |
| `doc/DEVELOPING.md` | Dev setup, worktrees, secrets, CLI |
| `doc/DATABASE.md` | DB modes, backups, secrets |
| `doc/CLI.md` | CLI reference |
| `skills/paperclip/SKILL.md` | Agent heartbeat procedure + API |
| `skills/paperclip/references/api-reference.md` | Full API tables |
