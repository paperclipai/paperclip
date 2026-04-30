# Phase 63: Mobile Push Notification Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 63-mobile-push-notification-loop
**Mode:** auto
**Areas discussed:** Implementation depth, Subscription and token lifecycle, Work signal and payload semantics, Delivery retry and click evidence, Capture reliability integration, PWA/native provider boundary, Operator evidence and blockers

---

## Implementation Depth

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-first push gate | Reuse Phase 60-62 deterministic manifest gate pattern before provider/native dependency work. | yes |
| Full provider runtime | Add real APNs/Web Push send path and credentials now. | |
| UI-only notification surface | Show notification placeholders without release-readiness evidence. | |

**Auto choice:** Evidence-first push gate.
**Notes:** Selected because v3.0 distribution phases are currently dependency-light and evidence-first, and this avoids APNs/Web Push secret churn while still closing `PUSH-01` through `PUSH-03` as operator-readable readiness evidence.

## Subscription and Token Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Company/user/device/provider-scoped registrations | Require explicit company, user/device, provider, platform, lifecycle state, revocation, and rotation evidence. | yes |
| Provider-only token list | Track tokens without company/user/device ownership. | |
| Browser-only subscription model | Treat Web Push/PWA as the only provider and defer APNs shape. | |

**Auto choice:** Company/user/device/provider-scoped registrations.
**Notes:** Selected to match `PUSH-01` and keep APNs/Web Push/PWA/native paths distinguishable without pretending one provider model covers all devices.

## Work Signal and Payload Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal routing payload | Send only signal type, scope, target, event ID/timestamp, and safe display labels; load details after authenticated navigation. | yes |
| Rich payload | Include task/draft/work content in the push payload. | |
| Generic notification text | Avoid target-specific routing details. | |

**Auto choice:** Minimal routing payload.
**Notes:** Selected to preserve privacy, RealTycoon2 review semantics, and native distribution secret hygiene. Required signals are `approval_waiting`, `failed_sync`, and `review_requested`.

## Delivery Retry and Click Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Structured delivery/click evidence | Track queued/sent/delivered/failed/retry/click states with stable failure and click-through codes. | yes |
| Delivery-only evidence | Validate sends but ignore notification clicks/deep links. | |
| Best-effort retry | Retry without bounded attempt and failure reporting. | |

**Auto choice:** Structured delivery/click evidence.
**Notes:** Selected because `PUSH-03` requires permission denied, invalid token, delivery failure, retry, and click-through metric visibility. Click-through must prove the board/review target was reached, not only that a notification was clicked.

## Capture Reliability Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing capture reliability evidence | Surface push permission, invalid token, delivery failure, retry, and click-through beside existing capture/review reliability reports. | yes |
| Separate notification dashboard | Create a standalone push notification operations UI. | |
| Release-gate only | Keep push evidence out of product reliability surfaces. | |

**Auto choice:** Extend existing capture reliability evidence.
**Notes:** Selected because the codebase already has capture queue/reliability report surfaces and Phase 63 signals map to approval waiting, failed sync, and review-requested board targets.

## PWA and Native Provider Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Additive PWA/service-worker hook plus APNs evidence contract | Use `ui/public/sw.js` if needed, model APNs as credential-free evidence, and defer real provider sends. | yes |
| Native-mobile scaffold now | Add Tauri/mobile or native package dependencies for push. | |
| APNs-only path | Ignore Web Push/PWA delivery for this milestone. | |

**Auto choice:** Additive PWA/service-worker hook plus APNs evidence contract.
**Notes:** Selected to keep Phase 63 compatible with the existing Web/PWA-first repo and Phase 59 Tauri/mobile boundary.

## Operator Evidence and Blockers

| Option | Description | Selected |
|--------|-------------|----------|
| Stable blocker taxonomy and `summary.json` | Write machine-readable and Markdown evidence with stable blocker codes for Phase 64 consumption. | yes |
| Markdown-only runbook | Document expected behavior without machine-readable evidence. | |
| Provider logs only | Rely on APNs/Web Push provider output as the release gate. | |

**Auto choice:** Stable blocker taxonomy and `summary.json`.
**Notes:** Selected to match previous native distribution gates and make Phase 64 aggregation straightforward.

## the agent's Discretion

- Exact manifest field names, report layout, blocker code naming, and whether push evidence is modeled as one combined manifest or sectioned subdocuments.
- Whether runtime-confidence aggregation is updated in Phase 63 or left to Phase 64, provided Phase 63 writes a stable summary file.
- Whether PWA service worker handlers are included in the first plan or left as evidence contract only, provided Web Push click semantics remain represented.

## Deferred Ideas

- Final all-up distribution gate belongs to Phase 64.
- Real credentialed APNs/Web Push provider sends in CI are deferred until secret management and release environment policy are explicitly planned.
- Full native mobile packaging, public store operations, reviewer account workflows, cross-company notification federation, and autonomous Jarvis apply are outside Phase 63.
