# Phase 42: Jarvis Autonomy Eval Guardrails - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** 42-jarvis-autonomy-eval-guardrails
**Mode:** auto
**Areas discussed:** Rewrite proposal boundary, Eval rubric and provider fallback, Approval/audit/contradiction linkage, Monitoring surface, Verification

---

## Rewrite Proposal Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Proposal-only | Jarvis writes proposed diffs with evidence, risk, eval, and approval route; no direct apply path exists. | yes |
| Direct apply with undo | Jarvis applies rewrite and relies on rollback/audit if wrong. | |
| Shadow-only suggestions | Jarvis only emits text suggestions without structured persistence. | |

**Auto choice:** Proposal-only.
**Notes:** Selected because roadmap success criteria explicitly require proposed diff/evidence/risk/approval route and no direct apply path.

---

## Eval Rubric And Provider Fallback

| Option | Description | Selected |
|--------|-------------|----------|
| One rubric schema | Provider-backed and deterministic fallback eval write the same typed rubric schema. | yes |
| Provider-only rubric | Eval is skipped or failed when the provider is unavailable. | |
| Separate fallback shape | Deterministic fallback stores simplified test-only fields. | |

**Auto choice:** One rubric schema.
**Notes:** Selected to satisfy provider-backed eval plus deterministic fallback eval under the same schema while keeping local/CI deterministic.

---

## Approval, Audit, And Contradiction Linkage

| Option | Description | Selected |
|--------|-------------|----------|
| Existing governance linkage | Reuse approval/activity log and link contradiction candidates/resolutions from proposal evidence. | yes |
| New isolated review queue | Build a separate Jarvis rewrite review system. | |
| Activity log only | Log proposal decisions without approval queue or contradiction review linkage. | |

**Auto choice:** Existing governance linkage.
**Notes:** Selected because prior phases established approvals, activity log, and contradiction review as the human decision and audit contracts.

---

## Monitoring Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Extend Knowledge Operations/Jarvis/Governance | Add proposal quality, eval disagreement, provider unavailable, stale citation, and contradiction warnings to existing operations surfaces. | yes |
| Standalone autonomy dashboard | Add a separate dashboard just for rewrite autonomy. | |
| Backend-only metrics | Store monitoring data but do not make it operator-visible. | |

**Auto choice:** Extend existing operations surfaces.
**Notes:** Selected to preserve the dense RT2 operator workflow and avoid another dashboard for the same knowledge/Jarvis loop.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic route/service/UI coverage | Cover no direct apply, provider unavailable, disagreement, low confidence, approval/audit linkage, contradiction linkage, and monitoring reason codes. | yes |
| Provider integration tests as primary | Depend on live provider behavior for core verification. | |
| Manual verification only | Rely on operator inspection for proposal/eval behavior. | |

**Auto choice:** Deterministic route/service/UI coverage.
**Notes:** Selected because repository workflow requires `pnpm typecheck && pnpm test`, and prior phases repeatedly preserve provider-optional deterministic fallback coverage.

## the agent's Discretion

- Exact table names, endpoint names, enum labels, and UI placement.
- Exact provider abstraction and timeout behavior.
- Exact rubric thresholds, provided high-risk and blocked states remain explicit.

## Deferred Ideas

- Fully autonomous knowledge rewrite apply without approval.
- Mandatory live provider dependency.
- Broad autonomous agent runtime beyond Jarvis rewrite proposal guardrails.
- Cross-company knowledge federation.
