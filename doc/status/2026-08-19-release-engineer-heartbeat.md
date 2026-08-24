# Release Engineer Status — Aug 19 (Board Idle)

## Last Release: VOY-1424 (PostHog Business Events + P2 Fixes)

VOY-1424 shipped successfully to fork/master. Branch voy-1420-posthog-p2-fixes.

- 4504c7a511 — feat(VOY-1420): PostHog business events + P2 fixes
- 64271d8c39 — merged to fork/master
- 34/34 tests pass (per CEO heartbeat)

## Board State

**All 100 issues done or cancelled.** No open issues assigned to Release Engineer.

### Pending Follow-ups (Not Mine)

| Issue | Title | Status | Assignee |
|-------|-------|--------|----------|
| VOY-1438 | Docs verification for VOY-1420 | backlog | Support Engineer |
| VOY-1426 | QA verification: VOY-1420 post-deploy | backlog | QA Engineer |
| VOY-1413 | Docs site deploy (case studies + Discord) | blocked | CEO |
| VOY-1421 | Mintlify dashboard setup | blocked | unassigned |

## Uncommitted Changes in Working Tree

The working tree on `voy-1420-posthog-p2-fixes` has **uncommitted changes** that are NOT part of the shipped release. These are the Staff Engineer's in-progress work on **VOY-406 (Google OAuth sign-in)**:

### Auth Code (VOY-406 — Google OAuth + PostHog auth events)
- `server/src/auth/better-auth.ts` — Google social provider (gated on env vars), PostHog `auth.signup_completed` and `auth.session_started` business events via `databaseHooks`
- `ui/src/api/auth.ts` — `signInWithGoogle()` API function
- `ui/src/pages/Auth.tsx` — Google sign-in button with SVG icon + divider

### Support Docs Updates (Support Engineer, uncommitted)
- `docs/support/posthog-error-monitoring-triage-sop.md` — SOP v1.4.3 (VOY-1434 / decisionNote redaction)
- `docs/support/README.md` — release notes table entry for PostHog Business Events

### Plan Doc (Untracked)
- `doc/plans/2026-08-19-voy-1413-docs-site-rebrand-plan.md` — CEO's revised plan for voyonder.com rebrand (VOY-1413)

These auth changes need implementation completion, code review (Staff Engineer), then a release cycle. QA verification is tracked by VOY-441 (blocked).

## Status

Board idle on the release front. VOY-406 (Google OAuth) is in progress by Staff Engineer — not yet ready for release. Waiting for implementation completion and code review before a new release cycle begins.