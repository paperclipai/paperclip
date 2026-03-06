# Paperclip Android QA Gate and Smoke Test Matrix (MVP)

Status: Active  
Owner: QA-1  
Date: 2026-03-05  
Related issue: OTTAA-48

## Scope

Define the minimum Android quality gate for Paperclip Mobile MVP so releases are blocked on core trust flows:

- Auth (login/session validity)
- Issue list read path (inbox visibility and refresh)
- Offline recovery (graceful degradation and reconnect behavior)

This document is intentionally narrow: it sets MVP ship gates, not full regression coverage.

## Release Stage Gate Criteria

| Stage | Target use | Required pass bar | Failure policy |
|---|---|---|---|
| M0: Dev Smoke | Local/dev validation before sharing builds | `AUTH-01`, `ISS-01`, `OFF-01` pass on 1 Android device/emulator | Non-blocking for branch work; blockers must be logged |
| M1: Internal Alpha | Team/internal testing track | 100% pass for all P0 smoke tests (`AUTH-01/03/04`, `ISS-01/02`, `OFF-01/02`) across 2 Android API levels | Block internal release |
| M2: Beta Candidate | Limited external beta | 100% pass for all P0 + >=95% pass for P1 smoke tests, no unresolved P0 defects | Block beta promotion |
| M3: Release Candidate | Production-ready candidate | 100% pass for all smoke tests (P0+P1), 0 flaky tests in 3 consecutive reruns | Block release |

## Smoke Test Matrix (MVP)

| ID | Priority | Flow | Scenario | Expected result | Stage coverage |
|---|---|---|---|---|---|
| AUTH-01 | P0 | Auth | Valid login on fresh install | User reaches authenticated issue inbox | M0-M3 |
| AUTH-02 | P1 | Auth | Invalid credentials | Error shown, no authenticated session created | M1-M3 |
| AUTH-03 | P0 | Auth | App restart with valid session | Session restored, user remains logged in | M1-M3 |
| AUTH-04 | P0 | Auth | Expired/invalid token on launch | App forces re-auth without crash/loop | M1-M3 |
| ISS-01 | P0 | Issue list read | Load assigned issues after login | Non-empty or valid empty-state list renders without error | M0-M3 |
| ISS-02 | P0 | Issue list read | Pull-to-refresh/manual refresh | List refreshes and preserves stable UI state | M1-M3 |
| ISS-03 | P1 | Issue list read | API error while online | User sees clear retryable error state | M1-M3 |
| OFF-01 | P0 | Offline recovery | Open app with no network after prior successful login | App shows offline state, no crash, last-known list when available | M0-M3 |
| OFF-02 | P0 | Offline recovery | Reconnect after offline state | App auto-recovers or succeeds on retry and refreshes issues | M1-M3 |
| OFF-03 | P1 | Offline recovery | Network drops during issue list fetch | Controlled failure state + successful recovery after reconnect | M2-M3 |

## Execution Strategy

1. Start with deterministic smoke coverage only; expand to full regression after MVP stability.
2. Run smoke suite on every internal release candidate build.
3. For M2+, run smoke suite in CI on Android emulator matrix (minimum 2 API levels).
4. Use a dedicated QA tenant and fixed QA users for repeatable auth/list data behavior.
5. Any P0 failure auto-flips release recommendation to NO-GO.

## Current Blockers (Filed with Severity)

The following blockers currently prevent full execution of this matrix:

1. P0 blocker: [OTTAA-59](/issues/OTTAA-59) — Auth + issue-list smoke cannot run until mobile shell exposes stable QA hooks and fixture-ready auth path.
2. P1 blocker: [OTTAA-60](/issues/OTTAA-60) — Offline recovery cannot be validated in CI until deterministic network disruption/recovery harness exists.
3. P1 dependency: [OTTAA-47](/issues/OTTAA-47) — Mobile CI lane is still being implemented, so automated gate enforcement is not yet active.

## Exit Criteria for This QA Work Item (OTTAA-48)

- Strategy document exists in repo.
- Smoke matrix includes auth, issue-list read, and offline recovery.
- Release-stage pass criteria are explicit and testable.
- Blockers are filed with severity and ownership.
