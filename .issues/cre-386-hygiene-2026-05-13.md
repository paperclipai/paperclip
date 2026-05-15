# Nightly Repo Hygiene QA — /opt/paperclip

**Date:** 2026-05-13  
**Branch:** `feat/opencode-deepseek-v4-switch`  
**Script:** Nightly hygiene audit  

## Checks Run & Results

| Check | Status | Detail |
|---|---|---|
| Merge conflicts | ✅ PASS | None found |
| Hardcoded secrets in tracked code | ✅ PASS | No API keys, tokens, or credentials detected |
| `.env` gitignored | ✅ PASS | `.env` in `.gitignore`, not tracked |
| TypeScript compilation (`tsc --noEmit`) | ✅ PASS | Compiles cleanly |
| Large files (>10MB) outside node_modules | ✅ PASS | None found |
| Git repository health | ✅ PASS | No corruption, valid branch |

## Issues Found

### ⚠️ MEDIUM — Stale `.env.backup` file
File `.env.backup-20260513-012546` sits in the repo root, owned by root, not gitignored. Its contents are a stale subset of the real `.env`. Risk of accidental commit leaking env structure.

**Action:** Delete the backup file.

### ⚠️ HIGH — Unstaged migration 0086
`packages/db/src/migrations/0086_budget_thresholds.sql` is **untracked** but `_journal.json` already references it (idx 86, tag `0086_budget_thresholds`). If the database migration runner checks `_journal.json` against filesystem for consistency, this will produce a hard failure on next deploy.

**Action:** `git add packages/db/src/migrations/0086_budget_thresholds.sql`

### ⚠️ LOW — Stale stash on master
`stash@{0}` contains "AI agent timeout policy — 1800s default for AI adapters". Unclear whether this was intentionally parked or abandoned.

**Action:** Review and either apply or `git stash drop`.

### ⚠️ LOW — `.env.example` drift
`.env.example` has `DATABASE_URL`, `SERVE_UI`, `BETTER_AUTH_SECRET`, `DISCORD_WEBHOOK_URL`. Actual `.env` has `HOST`, `BETTER_AUTH_BASE_URL`, `PAPERCLIP_PUBLIC_BASE_URL`. These document different configuration sets.

**Action:** Sync `.env.example` to reflect the actual required vars.

### ℹ️ INFO — Duplicate chase-telegram file trees
`scripts/chase-telegram/` and `supabase/functions/chase-telegram/` both contain identical new code (lib/, router.ts, types.ts, tools/). Likely Node ↔ Deno dual deploy, but worth documenting intent.

## Verdict

**QA passed with notes** — no blocking issues. Two actionable items recommended:
1. High: stage migration 0086 to prevent deploy failure
2. Medium: remove stale `.env.backup` file

