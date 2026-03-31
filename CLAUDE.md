# CLAUDE.md — Project-level instructions for Claude Code

## What is this repo?

Paperclip orchestrates AI agents for zero-human companies. The upstream repo
(`paperclipai/paperclip`) is designed for **self-hosted / localhost** usage.

**We (paperclipinc) operate a hosted multi-tenant SaaS offering of Paperclip at
paperclip.inc.** Our fork (`paperclipinc/paperclip`) carries SaaS-specific
hardening (rate limiting, tenant isolation, managed infrastructure) on top of the
upstream codebase.

## Rebase policy

We periodically rebase from the upstream (`paperclipai/paperclip`). Every rebase
must be reviewed with the SaaS context in mind:

- **Prefer upstream** — Always adhere to upstream where possible. If upstream
  implements something we already have, prefer their solution over ours and layer
  our SaaS-specific additions on top. During rebases, adapt or drop fork-specific
  code that upstream now covers.
- **Localhost assumptions** — Upstream code assumes a single-user, localhost
  environment. Watch for hardcoded `localhost` URLs, `pnpm dev` instructions in
  error messages, embedded Postgres usage, and TTY-only prompts. These are fine
  for local dev but must not leak into SaaS-facing code paths.
- **Multi-tenancy** — Any new route, service, or database query must be scoped to
  `companyId`. Cross-tenant data leakage is a critical issue.
- **Auth & permissions** — New permission checks, grant logic, or join flows must
  be reviewed for tenant boundary enforcement.
- **Migrations** — In SaaS, `PAPERCLIP_MIGRATION_AUTO_APPLY=true` is set. Verify
  new migrations are safe for zero-downtime rolling deploys (no locking ALTER
  TABLE on large tables, no breaking column renames without backfill).
- **Infrastructure** — Upstream uses embedded Postgres; SaaS uses managed
  Postgres + Redis (for rate limiting). Embedded Postgres changes only affect
  local dev.

## Development

- **Package manager:** pnpm (v9.15.4)
- **Node:** >= 20
- **Test runner:** vitest
- **PRs go to:** `paperclipinc/paperclip` (our fork), not upstream
- **Never commit `pnpm-lock.yaml`** — CI owns lockfile updates
