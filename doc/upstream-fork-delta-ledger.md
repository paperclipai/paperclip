# Upstream ↔ Fork Delta Ledger

Canonical record for the **weekly upstream integration review** (NEO-421, established by NEO-419).
Each weekly run appends an entry: what upstream range was integrated, and the state of our NEO
fork customizations (still fork-only / upstream-able / obsoleted by upstream).

Process: `git fetch upstream` → compute the delta from **this ledger's last "Upstream tip integrated"**
via `node scripts/upstream-delta-base.mjs --range` (⚠️ **NOT `git merge-base`** — our PRs squash-merge, so
merge-base is stale; see NEO-565) → `git log <that range>` → triage → merge (not rebase) onto
`sync/upstream-YYYYMMDD` → resolve schema→types→server→ui → NEW fork migrations in the reserved **10000+**
range → drop `pnpm-lock.yaml` for CI → `tsc -b` + targeted tests + fresh-DB apply → **append a new row here
with the upstream tip you merged** (that row is what keeps the *next* run squash-safe). Full rationale +
the NEO-522 deploy-train assessment: `doc/UPSTREAM_MERGE_SOP.md` § "Computing the delta (squash-resilient)".

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
| 2026-07-18 | `f12bb27bc` | **`869183e77`** (master, PR #42 squash-merged, **integrated** 2026-07-19) | 96 | **NEO-561→NEO-562. NOT a small weekly batch** — 96 commits, 839 files, 35 new upstream migrations (`0147`–`0181`). Merge = 11 real conflicts (`_journal.json`, `shared/index.ts`, `pnpm-lock`, `heartbeat-rewake` test, `app.ts`, `routes/{agents,index}`, `services/index`, `issue-execution-policy`, `Sidebar.tsx`, `AgentDetail.tsx`) — our NEO-411 `MarkdownEditor.tsx` + `better-auth.ts` auto-merged clean. **Dominant driver = a whole new upstream MCP tool-access/gateway governance subsystem** (`feat(mcp) [split 1/8..8/8]` + `tool-access.ts`/`tool-gateway.ts`/`tool-access-policy.ts` ≈30k LOC, migrations `0148`–`0169`). **Board direction `adopt_upstream_canonical`** (interaction `1ef5d8dd`): upstream tool-access/gateway is now the go-forward MCP system. **MCP is dual-system as of this land** — fork stack (`10000`–`10004`) coexists with upstream tool-access; fork-stack retirement tracked in **NEO-563** (blocked by this merge → now unblocked). CTO review (Werner): conflicts resolved schema→types→server→ui; migration chain `0147`–`0181` + fork `10000`–`10006` (no collision); `tsc -b` clean; Build/Typecheck+Release-Registry/general-server-tests/e2e/branding-guard/Canary all green. Fixed one PR-introduced regression: hand-committed `pnpm-lock.yaml` tripped the `policy` gate → restored to base so CI regenerates. Remaining CI red = **pre-existing NEO-552 only** (NEO-553 `agentMcpToolService` vi.mock, NEO-554/555 rebrand strings), not merge-induced. |

> ✅ **Squash-safe delta (permanent fix, NEO-565 — supersedes the 2026-07-19 temporary next-run guard).**
> Integration PRs are **squash-merged** (e.g. PR #42 → single-parent `869183e77`), so `upstream/master` is
> **not** an ancestor of master and `git merge-base <fork-line> upstream/master` resolves to a *stale* tip
> (`b49d178c4`, not `f12bb27bc`). Computing the delta from merge-base would re-surface every already-integrated
> commit as a phantom conflict. **The delta is now driven from this ledger's last "Upstream tip integrated",
> not from git ancestry** — run `node scripts/upstream-delta-base.mjs --range` (→ `f12bb27bc..upstream/master`)
> and `--check` (shouts `SQUASH DRIFT DETECTED` when merge-base is stale, which is the normal/expected case).
> Locked by `scripts/upstream-delta-base.test.mjs` in the `test:release-registry` suite so a squash can never
> silently break tracking again. We deliberately **keep squash merges** (not `--no-ff` true merges) because
> injecting upstream ancestry into master would inflate the NEO-522 deploy train's `git rev-list/log <LKG>..<candidate>`
> cut enumeration — see `doc/UPSTREAM_MERGE_SOP.md` § "Computing the delta (squash-resilient)".

## Fork-only NEO customizations (still diverge from upstream)

- **NEO-259** `heartbeat.ts` — heartbeat runs + auth context, recovery/handoff side-effects (async comment/wakeup writes). Fork-only. *Interacts* with upstream's new issue re-wake throttle (#9470): the rewake integration test's `afterEach` raced our async recovery inserts (FK on `issues` delete). Resolved test-only in **NEO-430** (2026-07-13) — `heartbeat-issue-rewake-throttle.test.ts` teardown now waits for a stable idle window (consecutive-idle debounce) + retries the FK-ordered deletes; production recovery unchanged.
- **NEO-28 / identity-auth** (`10000_neo28_identity_auth_framework`) — fork-only.
- **NEO-348…356 MCP stack** (`10002` registry, `10003` company_mcp_client_enabled, `10004` governance) — fork-only. ⚠️ **2026-07-18 (NEO-561): status changed.** Upstream now ships a large MCP **tool-access/gateway** governance subsystem (migrations `0148`–`0169`, `tool-access`/`tool-gateway`/`tool-access-policy` services, Apps/Tools/Profiles UI, Smoke Lab). This is a *different design* from our registry/governance, but the **conceptual surface overlaps**. ✅ **2026-07-19 RESOLVED (NEO-562): board direction `adopt_upstream_canonical`** — upstream tool-access/gateway landed (`869183e77`) as the canonical MCP system. Both systems now coexist (dual-system); **fork stack `10000`–`10004` retirement → upstream is tracked in NEO-563** (now unblocked).
- **NEO-210/294** `authorization.ts` — fork-only.
- **NEO-405/409/411** `MarkdownEditor.tsx` dictation harness — fork-only; re-applied onto upstream's editor refactor.
- **NEO-415** execution-policy self-heal (`issues.ts`) — fork-only.

## Upstream-able (candidates to push upstream, shrink fork surface)

- _(none identified yet — revisit as fork surface is characterized)_

## Obsoleted by upstream (fork delta now redundant, safe to drop)

- _(none this window)_
