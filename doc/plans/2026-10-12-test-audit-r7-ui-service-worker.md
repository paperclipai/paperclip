# Test audit, Round 7 UI — First service-worker takeover follow-up

This separate packet removes **1 registered executions, 0 rendered scenarios and 10 net test lines** from `ui/src/lib/service-worker-updates.test.ts`. It adds no helper and changes no production lines. Audit base: `2e76f5157240ee8b2d42adbdcd4c345aea07c013`. All prior committed proof remains byte-identical. Registration/render savings are per complete-suite invocation; no measured runtime or CI-speed claim is made. A service-worker retirement counts only initializer setup, never a render.

## Exact retirement map

| Retired registration | Keeper | Exact observations migrated |
|---|---|---|
| `does not reload on a first-ever install` | `reloads when a later deploy replaces the worker a first-visit tab installed` |  |

The retired complete body is an exact prefix of the keeper: fresh uncontrolled fake container, hidden document, reload mock, real startServiceWorkerUpdates invocation, first controllerchange and no-reload assertion. The keeper remains byte-identical, then verifies that the later takeover reloads exactly once. This retirement removes one registration and initializer/observer setup, not a render. Initial-controlled and uncontrolled states, visibility, update checks and cleanup cases stay distinct. The mutation incorrectly treats a first-visit tab as already controlled; the retained first no-reload guard fails, so the boundary remains clear and meaningful.

The verifier requires matching setup statements, enclosing hooks and explicit teardown where present. It reconstructs candidate source solely from the declared registrations/assertion migrations and requires exact byte equality plus full-program AST equality outside those edits. Existing shared variable bindings, mock arguments and provider/component inputs remain the same. No other fixture, helper, action order, wait, assertion strength, timer or cleanup changes. Default CI includes the file in `@paperclipai/ui` under `general-workspaces-a`, once across its two file shards, with no workflow/config change.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 9 | 9 | 0 | 0 |
| Candidate | 8 | 8 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/lib/service-worker-updates.test.ts`.

All 1 separately selected positive controls passed. All 1 distinct production-owner regressions failed at intended retained/migrated assertions, not setup, timeout or another guard:

| Regression | Intended guard |
|---|---|
| first-install | `expect(reload).not.toHaveBeenCalled()` |

Exactly one production owner changed per control, and every owner was restored byte for byte after each mutation and checked against pinned Git bytes. Literal keeper-name filters are escaped; unselected cases are not full-suite evidence. The initial first-install receipt verifier mistook emit( for it( and rejected its receipt despite the intended test failure. The declaration-boundary matcher was corrected and that control rerun; the rejected verifier attempt supplies no accepted evidence.

[Controls JSON](2026-10-12-test-audit-r7-ui-service-worker-controls.json) preserves source/owner hashes, exact before/after migrations, matched setup and variable-binding proof, complete-file run/log digests, intended assertion failures and restoration checks. Temporary raw scripts/logs are identified by digests rather than committed in full.

The earlier broad local `pnpm test:run` was intentionally stopped before completion and is not claimed as passed. These separate focused packets precede delivery-head replay and full CI. This packet includes no push, rebase, PR or merge.
