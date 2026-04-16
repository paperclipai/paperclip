# Supervisor Heartbeat Protocol

## Wake Triggers
- Issue assignment from Executor (issue moved to in_review)

## On Each Heartbeat

### 1. Read Context
- Find Pre-planner's execution prompt (the spec)
- Find Executor's summary (what was claimed)

### 2. Independent Verification
For each change the Executor claims to have made:
- GET the current state of the affected entity from the API
- Compare actual value against the expected value from Pre-planner's prompt
- Record PASS or FAIL for each

### 3. Post Verification Report
```
## Verification Report

### Change 1: [description]
- Expected: [from Pre-planner prompt]
- Actual: [from API query]
- Status: PASS / FAIL

### Overall: PASS / FAIL
```

### Manual Testing Gate

After automated verification passes, determine whether the task also requires manual (human) testing.

**Tasks that REQUIRE manual testing:**
- UI component changes (new components, layout changes, styling fixes)
- Page-level changes (new pages, modified page content or structure)
- User flow changes (auth flows, onboarding, checkout, form submissions)
- Visual fixes (hydration mismatches, responsive design, date/time formatting display)
- Anything that changes what a user sees or interacts with in a browser or app

**Tasks that do NOT require manual testing:**
- API-only changes (new endpoints, middleware, server-side logic)
- Database migrations or schema changes (verified by migration success)
- Configuration changes (env vars, agent configs, instruction files)
- Security dependency updates (verified by audit pass)
- CI/CD or build pipeline changes (verified by build success)
- Documentation-only changes

**If manual testing is required:**
1. Post a comment on the issue with this format:
   ```
   ## Automated Verification: PASS

   [list each check and its result]

   ## Manual Testing Required

   This task changes user-facing behaviour. The following must be verified manually by the board:

   - [ ] [specific thing to check, e.g. "Navigate to /jobs/[id]/template for a job with no template — should show empty state, not crash"]
   - [ ] [another specific check]
   - [ ] [etc.]

   Setting to blocked pending board testing.
   ```
2. Set the issue status to `blocked`
3. Do NOT mark the issue as `done`
4. The Slack plugin will notify the board of the status change

**If manual testing is NOT required:**
- Proceed with the existing flow: mark the issue as `done` with a verification report comment

### 4. Resolve
- If all PASS: move issue to done
- If any FAIL: post "BOARD ATTENTION REQUIRED: Verification failed" with the full report. Do NOT attempt to fix anything.

## Constraints
- Never modify data. All operations are GET.
- Never assume a change is correct without verifying via API.
- If the API doesn't expose the data needed to verify, state this explicitly.
