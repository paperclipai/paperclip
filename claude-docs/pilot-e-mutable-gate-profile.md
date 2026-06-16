# E — Mutable per-plan gateProfile (PATCH endpoint)

**Branch:** `pilot/b1-dogfood`
**Commit:** `a52cb3a0`

## What was added

`PATCH /plans/:issueId/gate-profile` — change a plan's gate protocol at any lifecycle stage.

Body: `{ "gateProfile": "none" | "solo" | "light" | "dev_team" }`

### Behavior by state

| Plan state | old → new | Side effect |
|---|---|---|
| `draft` | any → any | Profile update only (no approvals exist yet) |
| `active` | non-gated → gated | Creates missing pending gate approvals for root + tiers leaves |
| `active` | gated → non-gated | Cancels all pending gate approvals for plan's issues |
| `active` | same → same | 409 Conflict |
| `active` | gated → different-gated | Creates missing gates for new profile |

### Error responses

- `400` — invalid `gateProfile` value
- `404` — plan issue not found
- `409` — service throws conflict (same profile)

## Files changed

| File | Change |
|---|---|
| `server/src/services/plans.ts` | `setGateProfile(issueId, newProfile, actor)` method |
| `server/src/routes/plans.ts` | `setGateProfileSchema` + `PATCH /plans/:issueId/gate-profile` handler |
| `server/src/__tests__/plans-gate-profile.test.ts` | 4 route tests |

## Implementation detail

Upgrade: resolves gate-role agents by urlKey, builds specs via `buildGateApprovalsForActivation`, deduplicates against existing pending `(type, issueId)` pairs, inserts only missing approvals.

Downgrade: queries `issueApprovals JOIN approvals WHERE status = 'pending'` for all plan issues, filters by `isGateApprovalType`, bulk-cancels via `UPDATE approvals SET status = 'cancelled'`.

## Test coverage

- 400 on invalid enum value
- 404 on missing plan
- 409 when service throws HttpError(409)
- 200 with `{ planDetails, createdApprovalIds, cancelledApprovalIds }`
