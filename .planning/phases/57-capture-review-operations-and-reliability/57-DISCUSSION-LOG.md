# Phase 57: Capture Review Operations and Reliability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 57-capture-review-operations-and-reliability
**Areas discussed:** Review inbox filtering, Round-trip draft evidence, Reliability report metrics, API/UI placement and verification
**Mode:** auto — recommended defaults selected without interactive prompts.

---

## Review Inbox Filtering

| Option | Description | Selected |
|--------|-------------|----------|
| Extend the existing board capture inbox | Add compact source/status/evidence filters to `One-Liner 보드 검수함` and keep it the operations authority. | ✓ |
| Create a separate capture operations page | Move filtering into a new full-page dashboard. | |
| Only expose backend query params | Implement filters without visible operator controls. | |

**User's choice:** `[auto]` Extend the existing board capture inbox.
**Notes:** This follows Phase 54-56 decisions that the daily board remains the review authority.

---

## Round-Trip Draft Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Link through durable draft/revision metadata | Preserve `captureDraftId`, `captureDraftRevisionId`, and revision number on promoted work evidence. | ✓ |
| Duplicate full source payloads onto promoted work | Copy raw provider/source payload into task/todo/deliverable metadata. | |
| Rely only on activity log search | Operators would need to search audit logs to find source draft evidence. | |

**User's choice:** `[auto]` Link through durable draft/revision metadata.
**Notes:** This avoids storing secrets/raw payloads and matches Phase 54 promotion decisions.

---

## Reliability Report Metrics

| Option | Description | Selected |
|--------|-------------|----------|
| Add a narrow source-grouped reliability report | Show draft/failure/retry/promoted counts and promotion latency by source. | ✓ |
| Fold report metrics into each draft row | Inflate every queue item with report-only fields. | |
| Defer reliability to milestone closure only | Make Phase 58 infer reliability from tests/artifacts instead of product UI. | |

**User's choice:** `[auto]` Add a narrow source-grouped reliability report.
**Notes:** REVIEW-03 explicitly requires source-level draft count, failure count, retry count, and promotion latency.

---

## API/UI Placement And Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Typed shared contracts plus focused server/UI tests | Add filter/report contracts, route/service tests, and compact Korean UI tests. | ✓ |
| UI-only filtering and report rendering | Faster but leaves REVIEW-03 weakly verified. | |
| Large analytics dashboard | Exceeds Phase 57's capture-review scope. | |

**User's choice:** `[auto]` Typed shared contracts plus focused server/UI tests.
**Notes:** Focused tests and `pnpm typecheck` are the expected verification path on this host.

---

## the agent's Discretion

- Exact report route path and filter query encoding.
- Exact chip/dropdown layout inside the capture inbox.
- Exact latency summary formatting, provided average/max promotion latency is visible.

## Deferred Ideas

- Full native distribution, Slack/Teams marketplace OAuth distribution, federation, autonomous Jarvis apply, generic plugin webhook history, and broad BI analytics.
