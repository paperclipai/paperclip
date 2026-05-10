# BBA Memory CI Triage — 2026-05-10

**Author**: theproject1-glitch  
**Related PRs**: #5606 (Component 2 tests), #5636 (Phase F backend), #5641 (Phase F hardening UI)  
**Branch**: `docs/bba-ci-triage`

---

## Summary Table

| PR | Check | Category | Root Cause | Action | Owner |
|----|-------|----------|------------|--------|-------|
| #5606 | `policy` | **CONFIG→RESOLVED** | `pnpm-lock.yaml` committed; reverted in 2f2fb0b8 | ✅ policy now passes | Resolved |
| #5606 | `verify`/`e2e`/shards/Canary | **BY DESIGN** | No lockfile update for new deps — expected upstream pattern | Maintainer merges; `Refresh Lockfile` auto-creates lockfile PR | Maintainer |
| #5636 | `verify` | **REAL BUG** | TS2345 in CDP code at `betting-browser-automation.ts:2074` | ✅ Fixed in 86644f7e | Resolved |
| #5636 | `Canary Dry Run` | **REAL BUG** | Same TS2345 — same file/line | ✅ Fixed in 86644f7e | Resolved |
| #5641 | `verify` | **CASCADE** | Inherits #5636 TS error via stacking | Auto-resolves when #5636 CI is fixed | #5641 author |
| #5641 | `Canary Dry Run` | **CASCADE** | Same cascade from #5636 | Auto-resolves when #5636 CI is fixed | #5641 author |
| #5636 | `Verify serialized (3/4)` | **FLAKE** | DB state contamination: timeout → FK violation in teardown | Re-run; no code fix needed | Maintainer |

---

## Failure 1 — PR #5606 `policy` [CONFIG → RESOLVED]

**Check**: `policy`  
**Original run**: `25619199516` (lockfile in diff → policy failed)  
**Current run**: `25634184628` (lockfile reverted in `2f2fb0b8` → policy passes)

The `policy` job runs a bash script that diffs the PR branch against its merge base and exits 1 if `pnpm-lock.yaml` appears in the changed files. The initial commit on #5606 accidentally included a regenerated lockfile; Codex commit `2f2fb0b8` reverted it to the merge-base state. The `policy` check now passes.

**Status**: RESOLVED. See Failure 5 for the remaining install-job failures, which are expected.

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

## Failure 5 — PR #5606 `verify`/`e2e`/shards/`Canary Dry Run` [BY DESIGN]

**Check**: all install-dependent jobs (7 checks)  
**Run**: `25634184628`  
**Error on each**: `ERR_PNPM_OUTDATED_LOCKFILE` — `pnpm install --frozen-lockfile` fails because `ui/package.json` now references `@testing-library/react` and `happy-dom` which are absent from `pnpm-lock.yaml`

**This is the upstream's designed workflow for dep-adding PRs — not a fixable failure.**

Investigation findings:

`.github/workflows/pr.yml` line 57-63:
```yaml
- name: Validate dependency resolution when manifests change
  run: |
    changed="$(git diff --name-only "...")"
    manifest_pattern='(^|/)package\.json$|...'
    if printf '%s\n' "$changed" | grep -Eq "$manifest_pattern"; then
      pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
    fi
```
The `policy` job validates resolution works (via `--lockfile-only --no-frozen-lockfile`) but does NOT commit the result. All downstream jobs (`verify`, `e2e`, shards, `Canary`) still use `--frozen-lockfile` and WILL fail for any PR that adds deps.

`.github/workflows/refresh-lockfile.yml`: runs on every push to `master`, regenerates the lockfile if needed, and opens/updates `chore/refresh-lockfile` PR with auto-merge enabled. That branch is explicitly exempt from the policy check (`if: github.head_ref != 'chore/refresh-lockfile'`).

**Precedent**: PR #5589 ("chore: update drizzle-orm to 0.45.2") — no lockfile committed → `policy: PASS`, `verify/e2e/Canary/all shards: FAIL` → **merged by maintainer** on 2026-05-10T04:31Z → `chore/refresh-lockfile` companion PR #5610 auto-merged 8 minutes later.

**Recommended action for #5606**: No further code changes needed. The current state (`policy: PASS`, install jobs: FAIL) matches the expected pattern for dep-adding PRs. Maintainer should review and merge #5606 — the `Refresh Lockfile` workflow will automatically create and auto-merge a `chore/refresh-lockfile` PR within minutes.

**Owner**: Maintainer (merge decision).

---

## Human Actions Required

1. ~~**#5606 author**: Remove lockfile from PR diff~~ — ✅ Done in Codex commit `2f2fb0b8`; `policy` now passes
2. ~~**#5636 author**: Fix TS2345 at `betting-browser-automation.ts:2074`~~ — ✅ Resolved in commit `86644f7e` (`verify` + `Canary Dry Run` now pass)
3. **Maintainer**: Merge #5606 despite install-job failures (BY DESIGN — `Refresh Lockfile` handles lockfile post-merge automatically)
4. **Maintainer**: Re-run `Verify serialized server suites (3/4)` on #5636 (FLAKE — no code fix needed)
5. **Maintainer** (post-#5636 merge): `gh pr edit 5641 --base master --repo paperclipai/paperclip`
