# Test audit, Round 7 UI — Onboarding initial step follow-up

This separate packet removes **1 registered executions, 1 rendered scenarios and 9 net test lines** from `ui/src/components/OnboardingWizard.step.test.tsx`. It adds no helper and changes no production lines. Audit base: `2e76f5157240ee8b2d42adbdcd4c345aea07c013`. All prior committed proof remains byte-identical. Registration/render savings are per complete-suite invocation; no measured runtime or CI-speed claim is made. A service-worker retirement counts only initializer setup, never a render.

## Exact retirement map

| Retired registration | Keeper | Exact observations migrated |
|---|---|---|
| `opens on the agent step when the goals lookup fails outright` | `does not move an open wizard when a later refetch finds a mission` |  |

The retired complete five-statement body is an exact leading AST subset of the keeper, including the rejected goals mock, real route render, settle and agent-step assertion. The keeper is unchanged and then checks a later mission-cache update. Wizard opening/step effects and the real route resolver remain under test; explicit step, company change, reopen and in-flow behavior stay distinct. Existing global teardown remains unchanged.

The verifier requires matching setup statements, enclosing hooks and explicit teardown where present. It reconstructs candidate source solely from the declared registrations/assertion migrations and requires exact byte equality plus full-program AST equality outside those edits. Existing shared variable bindings, mock arguments and provider/component inputs remain the same. No other fixture, helper, action order, wait, assertion strength, timer or cleanup changes. Default CI includes the file in `@paperclipai/ui` under `general-workspaces-a`, once across its two file shards, with no workflow/config change.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 14 | 14 | 0 | 0 |
| Candidate | 13 | 13 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/OnboardingWizard.step.test.tsx`.

All 1 separately selected positive controls passed. All 1 distinct production-owner regressions failed at intended retained/migrated assertions, not setup, timeout or another guard:

| Regression | Intended guard |
|---|---|
| initial-agent-step | `expect(currentStep()).toBe("agent")` |

Exactly one production owner changed per control, and every owner was restored byte for byte after each mutation and checked against pinned Git bytes. Literal keeper-name filters are escaped; unselected cases are not full-suite evidence. The initial first-install receipt verifier mistook emit( for it( and rejected its receipt despite the intended test failure. The declaration-boundary matcher was corrected and that control rerun; the rejected verifier attempt supplies no accepted evidence.

[Controls JSON](2026-10-12-test-audit-r7-ui-onboarding-step-controls.json) preserves source/owner hashes, exact before/after migrations, matched setup and variable-binding proof, complete-file run/log digests, intended assertion failures and restoration checks. Temporary raw scripts/logs are identified by digests rather than committed in full.

The earlier broad local `pnpm test:run` was intentionally stopped before completion and is not claimed as passed. These separate focused packets precede delivery-head replay and full CI. This packet includes no push, rebase, PR or merge.
