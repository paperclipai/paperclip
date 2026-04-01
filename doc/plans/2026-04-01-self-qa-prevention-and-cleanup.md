# Self-QA Prevention + Pipeline Cleanup

**Date:** 2026-04-01

## Problem

The QA gate (`assertQAGate` in `server/src/routes/issues.ts`) blocks agents from marking code issues `done` without a `QA: PASS` comment. However, the assigned developer agent can post `QA: PASS` on their own issue and self-approve — defeating the purpose of independent QA review.

Additionally, several artifacts from the old plugin-based QA approach remain in the codebase as dead code.

## Design

### Self-QA Prevention

Add `assigneeAgentId` to the issue parameter of `assertQAGate`. When scanning comments for the approval pattern, skip any comment where `authorAgentId === issue.assigneeAgentId`. This ensures only a *different* agent or a board user can provide QA approval.

- Board users can always QA-approve (they have `authorUserId`, not `authorAgentId`)
- Board actors bypass the gate entirely (unchanged)
- Non-code issues skip the gate entirely (unchanged)

Gate name on self-QA rejection: `done_requires_qa_pass` (same gate, more specific error message).

### Cleanup

| Item | File | Action |
|------|------|--------|
| Dead entrypoint cron | `scripts/docker-entrypoint.sh` lines 28-34 | Remove `ensure-qa-gate.sh` cron block |
| Dead workflow | `.github/workflows/ai-review-override.yml` | Delete file |
| Stale branches | 3 merged remote branches | Delete |
| v3 ADR | `doc/plans/paperclip-enforceable-system-design-v3.md` | Add QA gate section |

### Doc updates

- `server/src/onboarding-assets/default/AGENTS.md` — note self-QA restriction
- `AGENTS.md` — update Definition of Done item 6

## Files Modified

- `server/src/routes/issues.ts` — `assertQAGate` signature + predicate
- `server/src/__tests__/qa-gate.test.ts` — new self-QA test cases
- `scripts/docker-entrypoint.sh` — remove dead cron
- `.github/workflows/ai-review-override.yml` — delete
- `doc/plans/paperclip-enforceable-system-design-v3.md` — update
- `server/src/onboarding-assets/default/AGENTS.md` — update
- `AGENTS.md` — update
