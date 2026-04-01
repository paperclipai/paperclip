# Enforceable System Design v3 — Architecture Decision

**Date:** 2026-03-31

## Status

Superseded in part — the Review Entry Guard (#1) and Release Guard (#3) are now implemented as **core service gates** in `server/src/routes/issues.ts` (`assertDeliveryGate()` and `assertQAGate()`), not as plugins. Both disabled QA gate plugins have been removed.

## Rationale

The plugin system uses a fire-and-forget event model (`onEvent` returns `void`, errors are caught and logged, `emit()` always completes). This makes plugins unsuitable for **blocking** enforcement — a plugin cannot reject an API request.

Core service gates in the route handler are the correct approach for hard enforcement:

- `assertDeliveryGate()` runs inline in the PATCH `/issues/:id` handler
- Returns a 422 rejection with a descriptive error when delivery artifacts are missing
- Logs `issue.delivery_gate_blocked` in the activity log for observability
- Only applies to `req.actor.type === "agent"` on issues with an `executionWorkspaceId`

## Gate Rules

### Delivery Gate (`assertDeliveryGate`)

| Transition | Requirement |
|------------|-------------|
| → `in_review` | At least one work product of type `branch`, `commit`, or `pull_request` |
| → `done` | A `pull_request` work product with status `active`, `ready_for_review`, `approved`, or `merged` |

### QA Gate (`assertQAGate`)

| Transition | Requirement |
|------------|-------------|
| → `done` | A comment matching `/\bqa[\s:]+pass(ed)?\b/i` from an authenticated author who is NOT the issue assignee |

Gate ordering: delivery gate fires first, then QA gate. This ensures "push your code" errors appear before "get QA approval" errors.

**Self-QA prevention:** The assigned agent's own `QA: PASS` comments are ignored. A different agent or board user must approve.

**Escape hatches (both gates):**
- Issues without `executionWorkspaceId` skip all gates (non-code issues)
- Board actors always bypass (only agents are gated)

## Three-Layer Design

1. **Instructions** — AGENTS.md, HEARTBEAT.md, and Definition of Done tell agents the protocol
2. **Workspace comment** — `buildWorkspaceReadyComment()` reminds at workspace provisioning time
3. **Hard gate** — `assertDeliveryGate()` enforces at the API level

## Files Modified

- `server/src/onboarding-assets/default/AGENTS.md` — Code Delivery Protocol section
- `server/src/onboarding-assets/ceo/HEARTBEAT.md` — Step 5 + CEO Responsibilities
- `AGENTS.md` — Definition of Done item 5
- `server/src/services/workspace-runtime.ts` — Delivery requirements in workspace ready comment
- `server/src/routes/issues.ts` — `assertDeliveryGate()` + PATCH handler integration
