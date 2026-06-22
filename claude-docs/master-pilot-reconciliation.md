# master ↔ pilot reconciliation (2026-06-22)

`master`, `pilot/b1-dogfood`, and both their `origin/*` counterparts now all point
at **`5132f598d`**. The fork has one validated main line.

## What happened

`pilot/b1-dogfood` held all real work (MyHive/dev-team platform, cost/budget fixes)
— 168 commits ahead of `origin/master`, 33 behind. We merged the 33 upstream-sync
commits (`origin/master` = `554f58f4`: codex/gemini/k8s adapters, UI routine pages,
upload limiter) **into pilot** on a throwaway branch `integrate/pilot-x-master`,
validated the whole tree, then fast-forwarded both `pilot` and `master` to it.

Merge commit: `2bac5baab`. Integration fixups: `5132f598d`.

### Conflicts resolved (all additive — kept both sides)
- `server/src/app.ts` — plan routes + file-resource routes both registered.
- `server/src/__tests__/openapi-routes.test.ts` — both route entries.
- `ui/src/components/Sidebar.tsx` — merged icon imports + rail-aware New Task button
  with Board/Monitor nav + soloMode Dashboard.
- `ui/src/pages/IssueDetail.tsx` — both icon imports.

### Integration fixups (`5132f598d`)
- `notes: null` added to ~17 Agent fixtures (pilot made `Agent.notes` required).
- `blockedInbox.ts` — added `pending_completeness_review` to the 3 exhaustive
  `Record<IssueBlockedInboxReason, X>` maps. **Latent pilot bug**: B2 added the enum
  value without map entries; master never had the value so this only surfaced merged.
- `packages/teams-catalog/generated/catalog.json` regenerated — committed artifact
  was stale vs pilot source (CTO `model` reverted sonnet→opus in `08fc1625b`;
  completeness-critic agent added in `7dc2e167f`/B2).
- teams-catalog tests synced to source: dev-team gate squad = 7 agents (adds
  "Completeness Critic" → reports to CTO); CTO model hint = `claude-opus-4-8`.

## Validation (all green before any ref moved)
- `pnpm -r build` ✓ · `pnpm -r typecheck` ✓
- `pnpm test:run` ✓ — 1896 passed / 1 skipped (241 files).

## Rollback
Backup tags retained: `backup/pilot-pre-merge` (`4d09053f`),
`backup/master-pre-merge` (`554f58f4`). Drop once master is confirmed good in CI.

## Deferred (out of scope — rebase cleanly on new master)
- `HIVA-25` (runcount/lastRunAt on agent list), `HIVA-27` (healthz alias) — children
  of old `origin/master`; rebase onto `5132f598d` when picked up.
- `HIVA-20` (dup upload, already on master) and `HIVA-29` (api/ping) — to delete.
- `bench/dev-roles-plans` worktree — unrelated, untouched.
