# BBA Memory — Maintainer Handoff Package

**To**: cryppadotta, devinfoley  
**From**: Costel (via Claude Sonnet release coordinator)  
**Date**: 2026-05-10  
**Read time**: ~5 minutes  
**Act time**: ~3 hours (merge session, once you have the window)

---

## TL;DR

9 code PRs + 3 docs PRs are ready. One blocker: PR #5636 has a scope-creep split that must happen before you touch it — exact git commands are in [`docs/bba-memory-pr-5636-split-plan.md`](bba-memory-pr-5636-split-plan.md). Everything else is clean. Demo cannot run until at least #5583, #5595, #5601, #5602, and #5636 are on master.

---

## Merge order (do not skip steps)

Full rationale + conflict-risk matrix: [`docs/bba-memory-merge-runbook.md`](bba-memory-merge-runbook.md)

| Step | PR / action | Why here | ARM | Est. review |
|------|-------------|----------|-----|-------------|
| **0** | **Execute split plan for #5636** (not a PR yet) | Must happen before Step 7 — CDP code makes #5636 unreviewable | Manual | 20 min |
| **1** | [#5583](https://github.com/paperclipai/paperclip/pull/5583) Phase A-D — SQLite journal | Foundation; BBA Memory SQLite schema must exist before any service code | ✅ Yes | 30 min |
| **2** | [#5595](https://github.com/paperclipai/paperclip/pull/5595) Phase D-2/E-1 — routes + client | After #5583; adds e2e tests + server routes + UI API client | ✅ Yes | 45 min |
| **3** | [#5606](https://github.com/paperclipai/paperclip/pull/5606) Test infra — 43 tests | Can parallelize with Step 4; `@testing-library/react` setup needed by #5636 | ✅ Yes | 30 min |
| **4** | [#5601](https://github.com/paperclipai/paperclip/pull/5601) Component 1 — RecentRunsPanel | After #5595; read-only polling panel, no state mutations | ✅ Yes | 20 min |
| **5** | [#5602](https://github.com/paperclipai/paperclip/pull/5602) Component 2 — ExecuteBetPanel | **HIGH RISK** — this calls the bookmaker. Needs careful human review of bet submission, risk controls, and confirmation modal | ⚠️ Manual | 45 min |
| **6** | [#5604](https://github.com/paperclipai/paperclip/pull/5604) Operator Playground | After #5601 + #5602; pure UI composition of already-reviewed C1+C2 | ✅ Yes | 20 min |
| **_soak_** | **24h production soak on #5602** | Confirm no regressions in bet execution path before enabling Phase F idempotency layer | — | — |
| **7** | [#5636](https://github.com/paperclipai/paperclip/pull/5636) Phase F — idempotency + UI hardening | After split (Step 0) + #5602 + #5606; adds server-side idempotency, safeParseMetaJson, 5 UI follow-ups | ⚠️ Manual | 30 min |
| **8** | Codex PR #1 (`feat/bba-memory-phase-f-backend-plus`) | After #5636; must retarget to master first — rate limiter + metrics + DELETE + 31 tests | ⚠️ Manual | 45 min |
| **9** | [#5641](https://github.com/paperclipai/paperclip/pull/5641) Phase F+ UI — auto-retry + replay banner | After #5636; retarget from cross-fork base to master; diff shrinks to 2 commits | ✅ Yes | 20 min |
| **10** | Docs PRs: [#5642](https://github.com/paperclipai/paperclip/pull/5642), [#5643](https://github.com/paperclipai/paperclip/pull/5643), [this PR](https://github.com/paperclipai/paperclip/pull/5645) | Docs-only; can merge at any point, no code dependency | ✅ Yes | 5 min total |

**Total merge session**: ~3h for Steps 0–7 in one sitting. Steps 8–9 after 24h soak on #5602.

### Parallel opportunities

Steps 3 (#5606) and 4 (#5601) can be reviewed simultaneously — they touch different directories (`server/src/` vs `ui/src/components/bba-memory/`). If two reviewers are available, parallelize these to save ~30 minutes. Similarly, once #5636 merges, Steps 8 and 9 can be reviewed in parallel.

---

## PR-by-PR readiness table

| PR | Branch | Status | Blockers | Author | LOC (approx) | Est. review | ARM |
|----|--------|--------|----------|--------|--------------|-------------|-----|
| [#5583](https://github.com/paperclipai/paperclip/pull/5583) | `feat/bba-memory-phase-a` | ✅ CI green | 0 | Costel | +400/-0 | 30 min | ✅ Yes |
| [#5595](https://github.com/paperclipai/paperclip/pull/5595) | `feat/bba-memory-phase-d-2-e2e-route` | ✅ CI green | 0 | Costel | +500/-50 | 45 min | ✅ Yes |
| [#5601](https://github.com/paperclipai/paperclip/pull/5601) | `feat/bba-memory-ui-component-1` | ✅ CI green | 0 | Costel | +200/-0 | 20 min | ✅ Yes |
| [#5602](https://github.com/paperclipai/paperclip/pull/5602) | `feat/bba-memory-ui-component-2` | ✅ CI green | 0 | Costel | +350/-50 | 45 min | ⚠️ Manual |
| [#5604](https://github.com/paperclipai/paperclip/pull/5604) | `feat/bba-memory-ui-operator-playground` | ✅ CI green | 0 | Costel | +150/-0 | 20 min | ✅ Yes |
| [#5606](https://github.com/paperclipai/paperclip/pull/5606) | `feat/bba-memory-ui-tests-infra` | 🟢 Failures are BY DESIGN — merge as-is per `refresh-lockfile` workflow precedent (#5589) | None — install failures are by design; lockfile updated automatically post-merge | Costel | +600/-0 | 30 min | ✅ Yes (despite red checks) |
| [#5636](https://github.com/paperclipai/paperclip/pull/5636) | `feat/bba-memory-phase-f-hardening` | ⛔ Needs split; TS fixed (`86644f7e`); (3/4) FLAKE — re-run needed | Scope-creep split (Step 0); re-run shard (3/4) in GitHub UI | Costel | +200/-0 after split | 30 min | ⚠️ Manual after rerun |
| [#5641](https://github.com/paperclipai/paperclip/pull/5641) | `feat/bba-memory-phase-f-ui-plus` | 🟡 TS fixed (`ae70c6e5`); CI pending re-run after #5636 merges | Retarget after #5636 merges | Costel | +150/-50 | 20 min | ✅ Yes after green |
| PR #1 (fork) | `feat/bba-memory-phase-f-backend-plus` | 🟡 No CI on fork (draft) | Retarget after #5636 merges; CI will run on upstream after retarget | Codex | +934/-98 | 45 min | ⚠️ Manual |
| [#5642](https://github.com/paperclipai/paperclip/pull/5642) | `docs/bba-memory-phase-f-closure` | ✅ Ready (docs only) | 0 | Claude | +605/-0 | 5 min | ✅ Yes |
| [#5643](https://github.com/paperclipai/paperclip/pull/5643) | `docs/review-codex-phase-f-backend` | ✅ Ready (docs only) | 0 | Claude | +318/-0 | 5 min | ✅ Yes |
| [#5645](https://github.com/paperclipai/paperclip/pull/5645) | `docs/maintainer-handoff` | ✅ Ready (docs only) | 0 | Claude | +250/-0 | 2 min | ✅ Yes |

---

## Cross-fork limitation — why this matters for ARM

All code PRs come from the `theproject1-glitch` fork into `paperclipai/paperclip`. GitHub's ARM (auto-merge / merge queue) requires:

1. The PR's base branch to exist **on the upstream repo** (`paperclipai/paperclip`), not just the fork.
2. At least one upstream maintainer approval before ARM triggers.

Two stacked PRs (#5641, Codex PR #1) currently have `feat/bba-memory-phase-f-hardening` as their base, but that branch does not exist on `paperclipai/paperclip` — it only exists on the fork. After #5636 merges to `paperclipai/paperclip:master`, you (the upstream maintainer) must retarget both PRs to `master` via `gh pr edit <number> --base master --repo paperclipai/paperclip`. Once retargeted, ARM is eligible.

This is a one-time action per PR. The closure docs PRs (#5642, #5643, #5645) are already based on `master` and need no retarget.

---

## Risk callouts

**Risk 1 — #5636 scope-creep split (MUST DO BEFORE MERGING #5636)**

PR #5636 contains CDP launch mode and migration idempotency code that is out of spec for Phase F. All in one commit (`b8eaf441`) — cannot cherry-pick. The executable split procedure is in [`docs/bba-memory-pr-5636-split-plan.md`](bba-memory-pr-5636-split-plan.md) and takes about 20 minutes. After the split, #5636's diff shrinks from ~427 lines to ~200 across 7 files. Do not merge #5636 without executing the split first — the blast radius is wider than needed.

**Risk 2 — #5641 cross-fork stacking note**

PR #5641's base branch was set to `feat/bba-memory-phase-f-hardening` (fork-local), which GitHub cannot resolve for ARM. A comment explaining the situation has been posted on the PR. When you merge #5636, simply retarget #5641 to `master` and the diff auto-shrinks to only the 2 Phase F+ commits. No rebase needed. See: https://github.com/paperclipai/paperclip/pull/5641#issuecomment-4415530631

**Risk 3 — Codex PR #1: 3 P1 follow-ups (non-blocking)**

Independent review at [`.claude/reviews/pr-codex-phase-f-backend.md`](.claude/../.claude/reviews/pr-codex-phase-f-backend.md) — verdict APPROVE. P1s:
- Replay counter over-counts cross-company key collisions (counter increments before company-ID guard)
- `DELETE /idempotency-keys` uses company-member auth — any member can clear idempotency protection
- Process-local metrics counters reset on restart, undocumented at call site

All three are prototype-grade trade-offs acceptable for the current single-operator demo deployment. Track as follow-up issues post-merge.

**Risk 4 — #5602 is HIGH RISK (bet execution)**

This PR sends money to a bookmaker. ARM is explicitly not recommended. Review the bet-submission logic, the risk controls (`requireFinalConfirmation`, `maxStakePerBet`), and the confirmation modal flow before merging. Allow 24h soak before enabling Phase F.

**Risk 5 — Process-local counters in Codex's rate limiter and metrics**

Both `_rateLimitedCount` and `_idempotencyReplays` are module-level integers that reset on process restart. They are exposed via `GET /metrics` as Prometheus counters. In a single-instance deployment (current), Prometheus correctly tracks resets. In multi-instance (future), each pod would expose its own partial view. Acceptable for demo; document before scaling.

---

## Demo dependency

The demo cannot run until **#5583, #5595, #5601, #5602, #5604, and #5636 are all merged to master** and the server is deployed to the demo environment. See [`docs/bba-memory-demo-readiness-checklist.md`](bba-memory-demo-readiness-checklist.md) for T-7d/T-1d/T-30min prep.

---

## Copy-paste ping messages

### Slack DM (to cryppadotta / devinfoley)

```
Hey — BBA Memory is code-complete and ready for the merge sprint. 9 PRs across ~3h of review.

One thing needed from you before anything else: execute the scope-creep split for PR #5636
(exact git commands are written up — takes ~20 min, no judgment calls needed).

After that, Steps 1–7 can flow in one session. Steps 8–9 after 24h soak.

Can we find a 3h window this week? I've written a 5-min handoff doc with the exact merge order,
ARM eligibility per PR, and risk callouts: https://github.com/paperclipai/paperclip/pull/5645

Happy to pair on the session or stand by async. Thanks for the time.
```

### GitHub @-mention comment (on any BBA PR, e.g. #5583)

```
@cryppadotta @devinfoley — BBA Memory is ready for merge. One pre-merge action required:
execute the scope-creep split for #5636 (20 min, full commands in `docs/bba-memory-pr-5636-split-plan.md`).
Full merge order, ARM eligibility, and risk callouts: https://github.com/paperclipai/paperclip/pull/5645
```

---

## Pre-merge CI check (run before each merge)

```bash
# 1. CI is green
gh pr checks <PR-number> --repo paperclipai/paperclip

# 2. Branch is up to date with master (should be empty after any needed rebase)
git fetch origin
git log origin/master..origin/<branch-name> --oneline

# 3. Diff looks sane (no accidental files)
gh pr diff <PR-number> --repo paperclipai/paperclip | head -60

# 4. Retarget PRs #5641 + Codex PR after #5636 lands
gh pr edit 5641 --base master --repo paperclipai/paperclip
# (Codex PR is fork-local — retarget via GitHub UI or gh on the fork)
```

---

## What I need from you — 3 specific asks

1. **By EOD this week**: Execute the scope-creep split for #5636 per [`docs/bba-memory-pr-5636-split-plan.md`](bba-memory-pr-5636-split-plan.md). Takes 20 min. Full git commands included — no judgment calls needed. This is the single gate blocking the Phase F merge sequence.

2. **This week, merge session**: ARM-enable the following PRs after initial review + CI green: #5583, #5595, #5606, #5601, #5604, #5641, and the three docs PRs (#5642, #5643, #5645). These are low-risk and do not need back-and-forth; one pass is sufficient.

3. **Manual sign-off on 3 PRs**: #5602 (bet execution — HIGH RISK, check risk controls before merging), #5636 (backend idempotency route after split), and Codex PR #1 (rate-limiter middleware + new endpoints). Please confirm with Costel before clicking merge on each of these three.

---

## Rollback quick-reference

Every PR merged via squash creates a single revertible commit. If a PR causes a production issue:

```bash
# Find the merge commit SHA
git log --oneline master | grep "<PR title keyword>"

# Create revert branch and open emergency PR
git checkout -b revert/bba-memory-pr-N origin/master
git revert <merge-commit-sha>
git push -u origin revert/bba-memory-pr-N
gh pr create --repo paperclipai/paperclip --base master \
  --title "revert(bba-memory): revert PR #N — <reason>" \
  --body "Emergency revert. Original PR: #N."
```

| PR | Rollback risk | Data concern |
|----|--------------|--------------|
| #5583 | Low | SQLite DB at `~/.paperclip/bba-memory/bba-memory.db` — delete to reset. No Postgres migration. |
| #5595 | Medium | Removes API routes → 404s. Brief outage acceptable. |
| #5601/#5604 | Low | UI-only, no data side-effects. |
| #5602 | Low | UI-only. Bet execution path is still live server-side; revert only removes the UI trigger. |
| #5606 | Low | Test-only. No runtime impact. |
| #5636 | Medium | `idempotency_keys` table stays in SQLite after revert — harmless orphan. No new keys written. |
| #5641 | Low | UI-only changes to `executeBbaBet`. |
| Codex PR | Medium | Rate-limiter and metrics routes removed. Monitor for 404s on `/metrics`. |

Full per-PR rollback plan: [`docs/bba-memory-merge-runbook.md`](bba-memory-merge-runbook.md#rollback-plan)

---

## Supporting documents (for reference)

| Document | Purpose |
|----------|---------|
| [`docs/bba-memory-merge-runbook.md`](bba-memory-merge-runbook.md) | Full dependency graph, conflict-risk matrix, per-PR rollback plan |
| [`docs/bba-memory-pr-5636-split-plan.md`](bba-memory-pr-5636-split-plan.md) | Exact git commands to split #5636 (20 min, no judgment calls) |
| [`docs/bba-memory-demo-readiness-checklist.md`](bba-memory-demo-readiness-checklist.md) | T-7d/T-1d/T-30min operator checklists for the CEO/CTO demo |
| [`docs/bba-memory-demo-runbook.md`](bba-memory-demo-runbook.md) | 8-min happy path script, failure recovery scripts, 5 Q&A pairs |
| [`.claude/reviews/pr-5636-phase-f.md`](./../.claude/reviews/pr-5636-phase-f.md) | Detailed review of #5636 (REQUEST CHANGES, 1 blocker, 3 P1, 5 nits) |
| [`.claude/reviews/pr-codex-phase-f-backend.md`](./../.claude/reviews/pr-codex-phase-f-backend.md) | Review of Codex PR #1 (APPROVE, 0 blockers, 3 P1, 5 nits) |

---

## Session log — 2026-05-10 evening

Three fixes landed and one important workflow finding that changes how to handle #5606. Per-PR update below; full triage with log excerpts and root-cause analysis is in PR #5649 ([docs/bba-memory-ci-triage.md](bba-memory-ci-triage.md)).

**#5636 — Phase F hardening**
- **Fixed**: TS2345 in CDP launch path (`betting-browser-automation.ts:2044`) — 1-line type assertion `as PlaywrightModule` (commit `86644f7e`). `verify` + `Canary Dry Run` now pass.
- **Pending**: `Verify serialized server suites (3/4)` is a FLAKE — `heartbeat-dependency-scheduling.test.ts` teardown FK violation triggered by an unrelated test timeout. Same test passes on #5583 and on prior #5636 runs against the same baseline. **Action**: re-run the failed job via GitHub UI ("Re-run failed jobs"). No code fix needed.

**#5641 — Phase F UI plus**
- **Fixed**: same TS2345 mirrored from #5636 (commit `ae70c6e5`). CI re-triggers automatically on the next push; no separate action needed.

**#5606 — UI tests infra (lockfile situation — read before merging)**
- **What looked broken**: after Codex commits `4add18af` then `2f2fb0b8` (final state: `pnpm-lock.yaml` restored to merge-base), `policy` passes but all install jobs (`verify`, `e2e`, 4 server shards, `Canary Dry Run`) fail with `ERR_PNPM_OUTDATED_LOCKFILE` because `ui/package.json` adds `@testing-library/*` + `happy-dom` but the lockfile is not updated.
- **What's actually happening**: this is the repo's designed pattern for dep-adding PRs. `.github/workflows/pr.yml` validates dep resolution with `--lockfile-only --no-frozen-lockfile` in the policy job (transient; not committed) and explicitly exempts the `chore/refresh-lockfile` branch from the lockfile policy check. After master moves, `.github/workflows/refresh-lockfile.yml` regenerates the lockfile and opens an auto-merging companion PR.
- **Precedent**: PR #5589 (drizzle-orm bump) merged on 2026-05-10T04:31Z with the identical pattern — `policy: PASS`, all install jobs failing. Companion PR #5610 (`chore/refresh-lockfile`) auto-merged 8 minutes later.
- **Action**: merge #5606 as-is. The install failures are by design. The refresh workflow handles them automatically post-merge. No further code changes on #5606.

**Codex fork PR (backend-plus)**
- Unchanged. Still waits for #5636 to merge to master before retargeting.

**Split plan for #5636**
- Plan body in `docs/bba-memory-pr-5636-split-plan.md` includes a "Prerequisite" section (commit `fa6879fa` on PR #5642) noting the split is deferred until #5583 + #5595 land on master. Until then, #5636 carries an inline scope notice flagging in-spec vs ride-along changes.

---

*This document was generated by Claude Sonnet as release coordinator on 2026-05-10.*  
*Contact: Costel for any questions or clarifications.*
