# BBA Memory CI Triage — 2026-05-10

**Author**: theproject1-glitch  
**Related PRs**: #5606 (Component 2 tests), #5636 (Phase F backend), #5641 (Phase F hardening UI)  
**Branch**: `docs/bba-ci-triage`

---

## Summary Table

| PR | Check | Category | Root Cause | Action | Owner |
|----|-------|----------|------------|--------|-------|
| #5606 | `policy` | **CONFIG** | `pnpm-lock.yaml` committed | Remove lockfile from PR diff | #5606 author |
| #5636 | `verify` | **REAL BUG** | TS2345 in CDP code at `betting-browser-automation.ts:2074` | ✅ Fixed in 86644f7e | Resolved |
| #5636 | `Canary Dry Run` | **REAL BUG** | Same TS2345 — same file/line | ✅ Fixed in 86644f7e | Resolved |
| #5641 | `verify` | **CASCADE** | Inherits #5636 TS error via stacking | Auto-resolves when #5636 CI is fixed | #5641 author |
| #5641 | `Canary Dry Run` | **CASCADE** | Same cascade from #5636 | Auto-resolves when #5636 CI is fixed | #5641 author |
| #5636 | `Verify serialized (3/4)` | **FLAKE** | DB state contamination: timeout → FK violation in teardown | Re-run; no code fix needed | Maintainer |

---

## Failure 1 — PR #5606 `policy` [CONFIG]

**Check**: `policy`  
**Run**: `25619199516`

The `policy` job runs a bash script that diffs the PR branch against its merge base and exits 1 if `pnpm-lock.yaml` appears in the changed files:

```
Do not commit pnpm-lock.yaml in pull requests. CI owns lockfile updates.
```

PR #5606 adds `@testing-library/react` and `happy-dom` to `ui/package.json`. The lockfile was regenerated locally and accidentally included in the commit. CI policy prohibits lockfile commits because pnpm lockfile updates are managed by the CI pipeline to prevent dev-environment drift.

**Recommended action**: Add a new commit on #5606 that reverts `pnpm-lock.yaml` to the state on `master` (`git checkout master -- pnpm-lock.yaml`). Do not amend — the branch has an open PR and amending would require force-push. The `policy` check will pass on the next push.

---

## Failure 2 — PR #5636 `verify` + `Canary Dry Run` [REAL BUG]

**Check**: `verify` (job `75231098027`) and `Canary Dry Run` (job `75231098028`)  
**Run**: `25629711149`

Both jobs fail with identical TypeScript error:

```
server/src/services/betting-browser-automation.ts(2074,15): error TS2345:
Argument of type 'typeof import(".../playwright/test/index") |
{ default: typeof import(".../playwright/test/index"); ... 14 more ...; webkit: BrowserType... }'
is not assignable to parameter of type 'typeof import(".../playwright/test/index")'
```

Line 2074 calls `connectChromiumProfileOverCdp(playwright, ...)`. The function signature (around line 559) expects `PlaywrightModule` — the exact namespace type — but `playwright` at the call site has a union type that includes a `{ default: ... }` shape. TypeScript cannot narrow the union to the exact type.

This code is in the out-of-spec CDP launch mode added by commit `b8eaf441`, which is the scope-creep that the [#5636 split plan](./bba-memory-pr-5636-split-plan.md) extracts into `chore/extract-cdp-and-migration-idempotency`.

**Recommended action (two options, pick one)**:

1. **Preferred** — Fix the type in the extraction PR (`chore/extract-cdp-and-migration-idempotency`): narrow `playwright` to `PlaywrightModule` before passing it, or adjust the union type at the import site.
2. **Expedient** — Add a type assertion at line 2074: `connectChromiumProfileOverCdp(playwright as PlaywrightModule, ...)`. Acceptable only if the extraction PR lands imminently and a proper fix follows.

Do not ship #5636 with this error present; `verify` and `Canary Dry Run` are both blocking checks.

---

## Failure 3 — PR #5641 `verify` + `Canary Dry Run` [CASCADE]

**Check**: `verify` + `Canary Dry Run`  
**Run**: `25631008594`

Identical error signature as Failure 2, same file, same line. PR #5641 (`feat/bba-memory-phase-f-hardening`) stacks on #5636 and includes the same out-of-spec CDP code unchanged. The TypeScript error propagates through the stack.

No independent fix is needed on #5641. Once #5636's TS2345 is resolved and its CI goes green, this failure disappears automatically — provided the maintainer retargets #5641 to `master` after #5636 merges (see [maintainer handoff](./bba-memory-maintainer-handoff.md) §Cross-Fork ARM Limitation for the `gh pr edit --base` step).

**Recommended action**: No action on #5641 directly. Block merge until #5636 is fixed and merged first, then retarget #5641 to `master`.

---

## Failure 4 — PR #5636 `Verify serialized server suites (3/4)` [FLAKE]

**Check**: `Verify serialized server suites (3/4)`  
**Run**: `25634074357` / Job: `75242782414`

```
FAIL @paperclipai/server src/__tests__/heartbeat-dependency-scheduling.test.ts
> heartbeat dependency-aware queued run selection
  > cancels stale queued runs when issue blockers are still unresolved

Error: Failed query: delete from "issues"
Caused by: PostgresError: update or delete on table "issues" violates foreign key
constraint "issue_comments_issue_id_issues_id_fk" on table "issue_comments"
```

The teardown deletes `issueComments` before `issues` (correct order, lines 127 → 133). The FK violation occurs because a **timeout in the same suite** (test at compiled line 152) aborts mid-execution, leaving `issue_comments` rows in the shared DB. The next test's `afterEach` then fails to delete `issues` because those orphaned rows still reference it.

**Baseline comparison**:
- Same test on prior #5636 run `25629711149` (same base code `b8eaf441`): **PASS** — all 4 shards green
- Same test on PR #5583: **PASS** — all 4 shards green
- Our fix commit `86644f7e` is a zero-JS type assertion: cannot affect test execution, DB state, or timing

**Category**: FLAKE — timing-sensitive integration test; cross-test DB contamination triggered intermittently by vitest test timeout.

**Recommended action**: Maintainer re-runs the failed check via GitHub UI (`Re-run failed jobs`). No code change needed. Underlying fragility (test timeout + missing isolation) is a pre-existing test quality issue in `heartbeat-dependency-scheduling.test.ts`, tracked separately.

**Owner**: Maintainer (re-run); test author for underlying timeout fragility.

---

## Human Actions Required

1. **#5606 author**: `git checkout master -- pnpm-lock.yaml && git commit -m "chore: remove lockfile from PR (policy fix)"` → push
2. ~~**#5636 author**: Fix TS2345 at `betting-browser-automation.ts:2074`~~ — ✅ Resolved in commit `86644f7e` (`verify` + `Canary Dry Run` now pass)
3. **Maintainer**: Re-run `Verify serialized server suites (3/4)` on #5636 (FLAKE — no code fix needed)
4. **Maintainer** (post-#5636 merge): `gh pr edit 5641 --base master --repo paperclipai/paperclip`
