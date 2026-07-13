# Upstream ↔ Fork Delta Ledger

Canonical record for the **weekly upstream integration review** (NEO-421, established by NEO-419).
Each weekly run appends an entry: what upstream range was integrated, and the state of our NEO
fork customizations (still fork-only / upstream-able / obsoleted by upstream).

Process: `git fetch upstream` → diff `upstream/master` vs merge-base → triage → merge (not rebase)
onto `sync/upstream-YYYYMMDD` → resolve schema→types→server→ui → NEW fork migrations in the
reserved **10000+** range → drop `pnpm-lock.yaml` for CI → `tsc -b` + targeted tests + fresh-DB apply.

---

## Integrated points

| Date | Upstream tip integrated | cortex-beta commit | Commits | Notes |
|------|------------------------|--------------------|---------|-------|
| 2026-07-11 | `e4e12bfb8` | `bb9ae53c4` | 391 | Initial catch-up merge (NEO-419, children 422–425). Migration renumber 0099/0100/0111–0113 → fork 10000+ range; editor error-boundary/rich-editor refactor re-applied; drizzle chain rebuilt. |
| 2026-07-13 | `b49d178c4` | `63d31f41e` | 10 | First weekly cadence run (NEO-421). All fixes/perf + one small routines feature; no schema-rewrite/auth/editor. Only conflict: drizzle `_journal.json` (upstream `0146` ordered after `0145`, before fork `10000+`). Verified: `tsc -b` clean, throttle-logic tests green, fresh-DB apply 150/150. |

## Fork-only NEO customizations (still diverge from upstream)

- **NEO-259** `heartbeat.ts` — heartbeat runs + auth context, recovery/handoff side-effects (async comment/wakeup writes). Fork-only. *Watch:* interacts with upstream's new issue re-wake throttle (#9470); see follow-up on the rewake integration-test teardown race.
- **NEO-28 / identity-auth** (`10000_neo28_identity_auth_framework`) — fork-only.
- **NEO-348…356 MCP stack** (`10002` registry, `10003` company_mcp_client_enabled, `10004` governance) — fork-only; upstream shipped ~zero MCP work this window, not redundant.
- **NEO-210/294** `authorization.ts` — fork-only.
- **NEO-405/409/411** `MarkdownEditor.tsx` dictation harness — fork-only; re-applied onto upstream's editor refactor.
- **NEO-415** execution-policy self-heal (`issues.ts`) — fork-only.

## Upstream-able (candidates to push upstream, shrink fork surface)

- _(none identified yet — revisit as fork surface is characterized)_

## Obsoleted by upstream (fork delta now redundant, safe to drop)

- _(none this window)_
