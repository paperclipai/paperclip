# Staff Engineer Review: VOY-1547 — Invite Flow E2E Test

**Reviewer:** Staff Engineer
**Issue:** VOY-1547 (Invite Flow E2E Test)
**Assignee:** Founding Engineer (57fa7e0e)
**Date:** 2026-08-20 ~23:30 UTC
**Branch:** master (working tree)
**Files reviewed:** `server/src/__tests__/invite-flow-e2e.test.ts`, `server/src/__tests__/onboarding-e2e.test.ts`

## Verdict: Structural issues found — fix before shipping

Both E2E suites pass against embedded PostgreSQL (invite-flow 3/3, onboarding 7/7). But the invite-flow test has a structural bug that survives CI.

---

## HIGH: `&&` in Drizzle `where()` drops the companyId + principalType filters

**File:** `server/src/__tests__/invite-flow-e2e.test.ts:340-344` and `:357-361`

```ts
.where(
  eq(companyMemberships.companyId, companyId) &&
    eq(companyMemberships.principalType, "user") &&
    eq(companyMemberships.principalId, INVITEE_USER_ID),
)
```

In JavaScript, `expr1 && expr2 && expr3` evaluates to **the last truthy operand only**. Drizzle `eq()` returns a truthy SQL expression object, so the entire chain collapses to just `eq(principalId, INVITEE_USER_ID)`. The `companyId` and `principalType` predicates are silently discarded:

- Intended: `WHERE company_id = ? AND principal_type = 'user' AND principal_id = ?`
- Actual:   `WHERE principal_id = ?` (company and type filters dropped)

Same bug in the grants query at line 357-361.

**Why the test still passes:** the test seeds exactly one company and one invitee, so `principalId` alone is unique. The assertion works by accident of test isolation. The moment a user has memberships in multiple companies (or a stale membership row exists from a prior test run), the query can match the wrong row and the assertions at 4b/4c either false-pass or spuriously fail.

**Fix:** import `and` from `drizzle-orm` and use `and(eq(...), eq(...), eq(...))` — the same pattern used everywhere else in the codebase (e.g. `access.ts`, `background-jobs.ts`).

---

## LOW: `inviteeWithAccessActor` hardcodes `membershipRole: "owner"`

**File:** `server/src/__tests__/invite-flow-e2e.test.ts:220-231`

The actor used in step 5 always claims `membershipRole: "owner"` regardless of the parameterized role (viewer/operator/admin). The board-access assertion only checks `companyIds`, so this is functionally harmless today, but it silently misrepresents the invitee's actual role. If a future assertion depends on the actor's role, it will assert against wrong data. Should be parameterized with the actual `role`.

---

## LOW: test file is untracked

Both `invite-flow-e2e.test.ts` and `onboarding-e2e.test.ts` are untracked (`git status` shows `??`). If the branch is switched or reset, the entire E2E coverage is lost. Commit them before marking done.

---

## Verified OK

- `onboarding-e2e.test.ts` — the `&&` at lines 410/412 is ordinary JS object access, not Drizzle. Clean.
- Invite token format, invite path/URL, role grants, join-request approval, and board-access assertions all match production behavior.
- Cleanup order (children before parents) is correct for FK constraints.
- Migration 0140 (invited_email/invited_name) exists and is committed — the issue description references "Migration 0139: invited_email/invited_name columns (untracked)" which is stale; the actual migration 0140_invited_email.sql is committed.

---

## Summary

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | HIGH | `&&` in Drizzle `where()` drops companyId + principalType filters | Use `and()` from drizzle-orm |
| 2 | LOW | `inviteeWithAccessActor` hardcodes `membershipRole: "owner"` | Parameterize with actual role |
| 3 | LOW | Test files are untracked (zero durability) | Commit before marking done |

**Routing:** These findings relate to VOY-1547, assigned to the Founding Engineer. The Staff Engineer is not authorized to write to that issue. This document serves as the review record. The CTO or Founding Engineer should apply the HIGH fix before shipping.