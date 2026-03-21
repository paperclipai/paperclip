# Pelergy Trial Workflow

Last reviewed: 2026-03-21
Scope: approval routing for Felix, Katya, and Mike during the Pelergy trial.

## Approval State Mapping

| Approval State | Felix | Katya | Mike | Meaning |
| --- | --- | --- | --- | --- |
| `draft` | Creates/updates request details. | Notified only. | Notified only. | Request is being prepared and is not yet submitted for decision. |
| `pending_felix` | Primary reviewer. | Waits. | Waits. | Request is queued for Felix to decide first-pass readiness. |
| `pending_katya` | Observes. | Primary approver. | Waits. | Request is queued for Katya business/governance decision. |
| `pending_mike` | Observes. | Observes. | Primary approver. | Request is queued for Mike technical/risk decision. |
| `approved` | Records approval note and closes request. | Records approval note when she is final approver. | Records approval note when he is final approver. | Request is accepted and may proceed. |
| `rejected` | Records rejection reason and returns to owner. | Can reject with business rationale. | Can reject with technical rationale. | Request is denied and requires a new submission to continue. |
| `cancelled` | Cancels stale/invalid requests. | Can request cancellation. | Can request cancellation. | Request is intentionally closed with no further action. |

## Routing Rules

1. New approval requests start in `draft` and move to `pending_felix` when submitted.
2. Felix routes high-level strategy and hiring decisions to `pending_katya`.
3. Felix routes technical and security-sensitive decisions to `pending_mike`.
4. Katya or Mike may return a request to `draft` with required changes instead of deciding.
5. Any final decision must end in `approved`, `rejected`, or `cancelled` with a short reason logged.

## Escalation

1. If a request remains in any `pending_*` state for more than 24 hours, Felix escalates in the issue thread.
2. If both Katya and Mike input is needed, the request moves `pending_katya` then `pending_mike` before finalization.
3. Urgent security actions may skip to `pending_mike` directly, but Felix must document the reason.
