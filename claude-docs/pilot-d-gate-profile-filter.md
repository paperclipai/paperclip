# D — gateProfile Filter on Issues List

**Branch:** `pilot/b1-dogfood`
**Commit:** `7a12254d`

## What was added

`GET /companies/:companyId/issues` now accepts a `?gateProfile=<value>` query parameter that filters the result set to issues whose `plan_details.gateProfile` matches the requested value.

Only plan-root issues have a `plan_details` row, so this filter implicitly selects plans by their gate protocol (e.g. `dev_team`, `none`).

## Files changed

| File | Change |
|---|---|
| `packages/shared/src/types/issue.ts` | No change — gateProfile is a plain string, no shared type needed |
| `server/src/services/issues.ts` | `gateProfile?: string` on `IssueFilters`; `gateProfileCondition()` EXISTS subquery; filter applied in 3 condition-builder sites |
| `server/src/routes/issues.ts` | Parse `req.query.gateProfile`, pass to `svc.list()` |
| `server/src/__tests__/issues-gate-profile-filter.test.ts` | 3 route tests |

## Implementation detail

```typescript
function gateProfileCondition(companyId: string, gateProfile: string): SQL {
  return sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${planDetails}
      WHERE ${planDetails.companyId} = ${companyId}
        AND ${planDetails.issueId} = ${issues.id}
        AND ${planDetails.gateProfile} = ${gateProfile}
    )
  `;
}
```

Pattern mirrors `hasPlanDocumentCondition`. Applied at all 3 condition-builder sites: blocked-inbox list, search list, count.

## Test coverage

- `?gateProfile=dev_team` → `issueService.list` called with `{ gateProfile: "dev_team" }`
- No param → `filters.gateProfile` is `undefined`
- Empty result → 200 with `[]`
