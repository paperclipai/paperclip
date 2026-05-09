# AGENTS.md

Paperclip = control plane for autonomous AI companies. V1 contract: `doc/SPEC-implementation.md`.

## Read First

1. `doc/GOAL.md` 2. `doc/PRODUCT.md` 3. `doc/SPEC-implementation.md` 4. `doc/DEVELOPING.md` 5. `doc/DATABASE.md`

## Repo Map

| Path | Purpose |
|------|---------|
| `server/src/routes/` | REST API endpoints |
| `server/src/services/` | Business logic |
| `ui/src/pages/` | React operator UI (React 19, Tailwind v4, shadcn/ui) |
| `packages/db/src/schema/` | Drizzle ORM table definitions |
| `packages/shared/` | Shared types, constants, validators |
| `packages/adapters/` | Agent runtime adapters (claude-local, codex-local, cursor-local, etc.) |
| `skills/` | Runtime-injected agent skills |
| `cli/` | `paperclipai` CLI client |
| `doc/` | Product and ops docs |

## Dev

```sh
pnpm install && pnpm dev  # API + UI at http://localhost:3100, embedded Postgres auto-starts
```

Reset: `rm -rf ~/.paperclip/instances/default/db && pnpm dev`

## Rules

1. **Company-scoped everything.** Every entity belongs to a company. Enforce in routes/services.
2. **Sync all layers on changes.** `packages/db` schema -> `packages/shared` types -> `server` routes/services -> `ui` pages.
3. **Never break invariants.** Single-assignee tasks, atomic checkout, approval gates, budget hard-stop, activity logging.
4. **Auth.** Operator = full control. Agents = bearer API keys, company-scoped. HTTP errors: 400/401/403/404/409/422/500.
5. **DB changes.** Edit schema -> export from index -> `pnpm db:generate` -> `pnpm -r typecheck`.
6. **Don't replace strategic docs wholesale.** Additive updates only. Plans go in `doc/plans/YYYY-MM-DD-slug.md`.
7. **Don't commit `pnpm-lock.yaml`.** CI owns it.

## Done = All True

1. Matches `doc/SPEC-implementation.md`
2. `pnpm -r typecheck && pnpm test:run && pnpm build` all pass
3. Contracts synced across db/shared/server/ui
4. Docs updated if behavior changed
