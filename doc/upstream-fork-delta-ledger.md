# Upstream ↔ Fork Delta Ledger

Canonical record for the **weekly upstream integration review** (NEO-421, established by NEO-419).
Each weekly run appends an entry: what upstream range was integrated, and the state of our NEO
fork customizations (still fork-only / upstream-able / obsoleted by upstream).

Process: `git fetch upstream` → diff `upstream/master` vs merge-base → triage → merge (not rebase)
onto `sync/upstream-YYYYMMDD` → resolve schema→types→server→ui → NEW fork migrations in the
reserved **10000+** range → drop `pnpm-lock.yaml` for CI → `tsc -b` + targeted tests + fresh-DB apply.

## Testing discipline (standing rule for this routine)

Every run must leave the tree green, and any *new behavior we author* must ship with a test:

1. **Run, don't just merge.** Each run runs `tsc -b`, the test suites covering every file the delta
   touches, migration numbering, and a fresh-DB apply. No red tests may remain in the tree.
2. **Upstream features arrive with their own tests** — we adopt and run them; we do not re-author them.
3. **Net-new fork production code → net-new tests, same change.** If a run introduces fork logic
   (not just conflict resolution), it must add/extend tests for that behavior. Integration weeks that
   author no new production behavior need no new production tests — but say so explicitly.
4. **Fork ↔ upstream interaction bugs get a regression test.** When our fork deltas break an upstream
   test (or vice-versa), fix it with a durable test-level guard, not a one-off (e.g. NEO-430).
5. **Conflict-resolution of data/config** (drizzle journal, lockfiles) is covered by the existing
   migration-safety / numbering / fresh-DB guards — no bespoke test required, but those guards must run.

---

## Integrated points

| Date | Upstream tip integrated | cortex-beta commit | Commits | Notes |
|------|------------------------|--------------------|---------|-------|
| 2026-07-11 | `e4e12bfb8` | `bb9ae53c4` | 391 | Initial catch-up merge (NEO-419, children 422–425). Migration renumber 0099/0100/0111–0113 → fork 10000+ range; editor error-boundary/rich-editor refactor re-applied; drizzle chain rebuilt. |
| 2026-07-13 | `b49d178c4` | `63d31f41e` | 10 | First weekly cadence run (NEO-421). All fixes/perf + one small routines feature; no schema-rewrite/auth/editor. Only conflict: drizzle `_journal.json` (upstream `0146` ordered after `0145`, before fork `10000+`). Verified: `tsc -b` clean, throttle-logic tests green, fresh-DB apply 150/150. |
| 2026-07-18 | `f12bb27bc` | _(deferred — see triage)_ | 96 | **NEO-561. NOT a small weekly batch** — 96 commits, 841 files, 35 new upstream migrations (`0147`–`0181`). Trial merge = only **11 real conflicts** (`_journal.json`, `shared/index.ts`, `pnpm-lock`, `heartbeat-rewake` test, `app.ts`, `routes/{agents,index}`, `services/index`, `issue-execution-policy`, `Sidebar.tsx`, `AgentDetail.tsx`) — our NEO-411 `MarkdownEditor.tsx` + `better-auth.ts` auto-merged clean. **Dominant driver = a whole new upstream MCP tool-access/gateway governance subsystem** (`feat(mcp) [split 1/8..8/8]` + `tool-access.ts`/`tool-gateway.ts`/`tool-access-policy.ts` ≈30k LOC, migrations `0148`–`0169`) that **overlaps our fork's own MCP stack** (`10002`–`10004`). Merge is all-or-nothing (linear drizzle chain), so adopting it is a **product-direction call, not a mechanical merge**. Per process rules 4+6: **split to child issue + surfaced to board (request_confirmation on NEO-561)**; nothing merged this run pending direction. |

## Fork-only NEO customizations (still diverge from upstream)

- **NEO-259** `heartbeat.ts` — heartbeat runs + auth context, recovery/handoff side-effects (async comment/wakeup writes). Fork-only. *Interacts* with upstream's new issue re-wake throttle (#9470): the rewake integration test's `afterEach` raced our async recovery inserts (FK on `issues` delete). Resolved test-only in **NEO-430** (2026-07-13) — `heartbeat-issue-rewake-throttle.test.ts` teardown now waits for a stable idle window (consecutive-idle debounce) + retries the FK-ordered deletes; production recovery unchanged.
- **NEO-28 / identity-auth** (`10000_neo28_identity_auth_framework`) — fork-only.
- **NEO-348…356 MCP stack** (`10002` registry, `10003` company_mcp_client_enabled, `10004` governance) — fork-only. ⚠️ **2026-07-18 (NEO-561): status changed.** Upstream now ships a large MCP **tool-access/gateway** governance subsystem (migrations `0148`–`0169`, `tool-access`/`tool-gateway`/`tool-access-policy` services, Apps/Tools/Profiles UI, Smoke Lab). This is a *different design* from our registry/governance, but the **conceptual surface overlaps** — potential redundancy or divergence. Reconciliation (adopt upstream / keep fork / merge the two) is the open **direction question** now before the board; blocks the child integration issue. No longer safe to call "not redundant" without that decision.
- **NEO-210/294** `authorization.ts` — fork-only.
- **NEO-405/409/411** `MarkdownEditor.tsx` dictation harness — fork-only; re-applied onto upstream's editor refactor.
- **NEO-415** execution-policy self-heal (`issues.ts`) — fork-only.

## Upstream-able (candidates to push upstream, shrink fork surface)

- _(none identified yet — revisit as fork surface is characterized)_

## Obsoleted by upstream (fork delta now redundant, safe to drop)

- _(none this window)_
