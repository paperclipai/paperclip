# Test audit, Round 7 UI — Issue filter popover follow-up

This separate packet removes **1 registered executions, 1 rendered scenarios and 22 net test lines** from `ui/src/components/IssueFiltersPopover.test.tsx`. It adds no helper and changes no production lines. Audit base: `2e76f5157240ee8b2d42adbdcd4c345aea07c013`. All prior committed proof remains byte-identical. Registration/render savings are per complete-suite invocation; no measured runtime or CI-speed claim is made. A service-worker retirement counts only initializer setup, never a render.

## Exact retirement map

| Retired registration | Keeper | Exact observations migrated |
|---|---|---|
| `hides the Priority filter section while priority UI is off (PAP-411)` | `uses a scrollable popover and a three-column desktop grid` | expect(popoverContent?.textContent).toContain("Status");; expect(popoverContent?.textContent).not.toContain("Priority"); |

Both registered cases use identical streamlined props, filter state, agents/projects/labels and routine-visibility flag, root/act render and positive popover lookup. The existing rich scroll/layout keeper gains exact Status-presence and Priority-absence checks before its original layout assertions. Real IssueFiltersPopover.tsx gates the Priority section independently of Status. Option search, legacy presentation and interactive inbox-scope cases remain unchanged. Existing teardown is unchanged.

The verifier requires matching setup statements, enclosing hooks and explicit teardown where present. It reconstructs candidate source solely from the declared registrations/assertion migrations and requires exact byte equality plus full-program AST equality outside those edits. Existing shared variable bindings, mock arguments and provider/component inputs remain the same. No other fixture, helper, action order, wait, assertion strength, timer or cleanup changes. Default CI includes the file in `@paperclipai/ui` under `general-workspaces-a`, once across its two file shards, with no workflow/config change.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 5 | 5 | 0 | 0 |
| Candidate | 4 | 4 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/IssueFiltersPopover.test.tsx`.

All 2 separately selected positive controls passed. All 2 distinct production-owner regressions failed at intended retained/migrated assertions, not setup, timeout or another guard:

| Regression | Intended guard |
|---|---|
| status | `expect(popoverContent?.textContent).toContain("Status")` |
| priority | `expect(popoverContent?.textContent).not.toContain("Priority")` |

Exactly one production owner changed per control, and every owner was restored byte for byte after each mutation and checked against pinned Git bytes. Literal keeper-name filters are escaped; unselected cases are not full-suite evidence. The initial first-install receipt verifier mistook emit( for it( and rejected its receipt despite the intended test failure. The declaration-boundary matcher was corrected and that control rerun; the rejected verifier attempt supplies no accepted evidence.

[Controls JSON](2026-10-12-test-audit-r7-ui-filters-controls.json) preserves source/owner hashes, exact before/after migrations, matched setup and variable-binding proof, complete-file run/log digests, intended assertion failures and restoration checks. Temporary raw scripts/logs are identified by digests rather than committed in full.

The earlier broad local `pnpm test:run` was intentionally stopped before completion and is not claimed as passed. These separate focused packets precede delivery-head replay and full CI. This packet includes no push, rebase, PR or merge.
