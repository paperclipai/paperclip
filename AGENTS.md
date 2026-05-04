# AGENTS.md — Paperclip / RealTycoon2

## Golden Rule 1 — Korean-First Communication

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 작성한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

---

## Identity

**Paperclip** is the control plane for autonomous AI companies. **RealTycoon2** is the evolved product direction for iSens Corp. — a company automation platform combining OKR management, deliverable-based work, gamification, and Jarvis AI agents.

This repo is Paperclip. RealTycoon2 is the target identity when building toward that vision.

---

## Dev Commands

```sh
pnpm install          # First-time setup
pnpm dev              # Full dev: API (localhost:3100) + UI with watch mode
pnpm dev:once         # Full dev without file watching (auto-applies migrations)
pnpm dev:server       # Server only
pnpm dev:ui           # UI only
pnpm dev:list         # Show running dev servers
pnpm dev:stop         # Stop running dev servers

pnpm build            # Build all packages
pnpm typecheck        # Type-check all packages
pnpm test             # Vitest unit tests only (default, fast)
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright browser suite (separate, not default)
pnpm test:release-smoke # Release smoke test

pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations

pnpm paperclipai <cmd> # CLI commands (onboard, configure, doctor, etc.)
```

**Lockfile policy**: Do NOT commit `pnpm-lock.yaml` in PRs. CI regenerates it on push to master.

---

## Architecture

**Monorepo structure** (pnpm workspace):
```
packages/*            # Shared packages (db, shared, adapters, plugins, mcp-server)
packages/adapters/*   # Agent adapters (claude-local, codex-local, openclaw-gateway, etc.)
packages/plugins/*   # Plugin system and examples
server/               # Express API server
ui/                   # React + Vite frontend
cli/                  # Paperclip CLI tool
```

**Dev default**: Embedded PostgreSQL (PGlite) — no external DB needed. Data lives at `~/.paperclip/instances/default/db`.

**Storage default**: `local_disk` provider at `~/.paperclip/instances/default/data/storage`.

---

## Important Quirks

- **Embedded Postgres**: Leave `DATABASE_URL` unset for dev. Server auto-uses embedded PGlite.
- **Worktree dev**: When using git worktrees, run `paperclipai worktree init` first to create isolated instance. Two servers cannot share the same embedded DB.
- **CLI entry**: `pnpm paperclipai` or `pnpm realtycoon2` both route to the same CLI.
- **Secrets**: Agent env vars support secret references. Default local key at `~/.paperclip/instances/default/secrets/master.key`. Use `PAPERCLIP_SECRETS_STRICT_MODE=true` outside local dev.
- **Migrations**: `pnpm dev:once` auto-applies pending migrations. `pnpm db:migrate` manually applies.

---

## What NOT to Do

- Do NOT run `pnpm test:e2e` as the default test — it's a separate Playwright suite for browser flows only
- Do NOT commit `pnpm-lock.yaml` changes in PRs
- Do NOT set `DATABASE_URL` unless you want external Postgres
- Do NOT use `rm -rf ~/.paperclip` to "reset" — just delete the DB subdirectory

---

## Source of Truth Order

When instructions conflict, prefer (in order):
1. User's explicit instruction
2. This AGENTS.md
3. `doc/DEVELOPING.md` (developer setup, commands)
4. `doc/PRODUCT.md` / `doc/SPEC.md` (product definition)
5. `doc/DATABASE.md` (schema guidance)
6. Existing code behavior
7. Reference docs in `doc/REFERENCE-*.md`

---

## RealTycoon2 Product Context

RealTycoon2 builds on Paperclip with:
- OKR + KPI hierarchy (Mission → Objective → Key Result → Project → Task → To-Do)
- Deliverable-first tasks with price/quality evaluation
- Gold/coin ledger, gamification, CareerMate
- Jarvis AI agents (Shadow → Co-Pilot → Auto modes)
- wikiLLM-style cumulative knowledge wiki
- Graphify-style knowledge graph

When working on RealTycoon2 features, prefer RealTycoon2 terminology over Paperclip legacy terms in product-facing code.

---

## Key Files

| File | Purpose |
|------|---------|
| `doc/DEVELOPING.md` | Full dev setup, commands, worktree guide |
| `doc/PRODUCT.md` | Product definition and principles |
| `doc/SPEC.md` | Technical specification (company model, agent adapters, heartbeat protocol) |
| `doc/DATABASE.md` | Schema guidance |
| `feedback_gsd_overkill.md` | Korean: mechanical cleanup shouldn't trigger full GSD cycles |
| `packages/db/src/migrations/` | Database migrations (Drizzle) |

---

## Workflow

1. Understand the request
2. Check relevant docs (see order above)
3. Identify smallest safe scope
4. Implement
5. Run verification: `pnpm typecheck && pnpm test`
6. Report changes and what was skipped

Do not over-plan, do not run unrelated rewrites, do not invoke gstack/superpowers ceremonies unless explicitly asked.
