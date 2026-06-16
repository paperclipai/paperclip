# F — CTO Autonomous gateProfile Selection

**Branch:** `pilot/b1-dogfood`
**Commit:** `9c1cd1b1`

## What was added

Instruction in the CTO agent AGENTS.md: before assigning child issues on any plan, the CTO reads the plan description, selects the appropriate gate profile, and calls:

```
PATCH /api/plans/<planRootIssueId>/gate-profile
{ "gateProfile": "<profile>" }
```

### Selection heuristic

| Scenario | Profile |
|---|---|
| Production code change, API modification, DB migration | `dev_team` |
| Docs, config, trivial rename, single-file tweak | `none` |
| Minor backend-only change, no auth/data path | `light` |

When in doubt: `dev_team`.

## Files changed

| File | Change |
|---|---|
| `server/src/onboarding-assets/cto/AGENTS.md` | Added `## Gate profile selection` section |
| `packages/teams-catalog/catalog/bundled/software-development/dev-team/agents/cto/AGENTS.md` | Same section |

## Design notes

- Instruction placed before "What you must never do" — read early in the CTO's operating loop
- Ordering constraint explicit: must happen before step 2 (assigning children) so gate approvals exist when implementors start
- Skip guard: if board already set a non-`none` profile at activation, CTO skips the PATCH call (idempotent by backpressure, not by check)
- Requires E (PATCH endpoint) which was implemented in the prior task
