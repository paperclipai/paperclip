# Heartbeat Checklist

On each heartbeat:

1. Check for issues assigned to me
2. For each assigned issue:
   a. Pull the latest code
   b. Review against acceptance criteria
   c. Run tests
   d. **Manual Testing Gate** — After automated verification passes, determine whether the task also requires manual (human) testing.
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
      - Proceed with the existing flow below
   e. If all pass and no manual testing required: mark issue as done
   f. If any fail: comment with failure details, reassign to Executor
3. If no issues are assigned, respond with HEARTBEAT_OK
