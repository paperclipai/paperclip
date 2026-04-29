# Phase 39: Enterprise Connector Apply Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in `39-CONTEXT.md` are the canonical source.

**Date:** 2026-04-29
**Phase:** 39-enterprise-connector-apply-loop
**Mode:** discuss auto
**Flags:** `--auto --chain`

## Auto-Selected Gray Areas

`[--auto] Selected all gray areas: IdP handshake evidence, SCIM preview-to-apply lifecycle, activity log/readiness linkage, operator surface, deterministic verification.`

## Decisions Captured

### IdP Handshake Evidence

Options considered:
- Extend existing SSO validation with persisted evidence (selected)
- Create a separate identity provider subsystem
- Treat validation as transient route-only output

Auto decision:
- Reuse `server/src/services/rt2-enterprise.ts` validation path and persist validation/apply evidence so rollout overview can show last verified state.

Reason:
- Phase 20 already established SSO metadata validation and readiness. Phase 39 is an operational hardening phase, not a greenfield identity rewrite.

### SCIM Preview To Apply

Options considered:
- Add apply mutation gated by preview identifier/fingerprint (selected)
- Apply directly from arbitrary request payload
- Keep preview-only behavior

Auto decision:
- Promote current `previewScimSync` candidate output into a preview/apply lifecycle with stale preview detection and explicit deactivate acknowledgement.

Reason:
- `EXT-02` requires promotion from preview to apply, result storage, and rollback candidates. Direct payload apply would weaken auditability.

### Rollback Candidate Semantics

Options considered:
- Record rollback candidates and evidence only (selected)
- Implement automatic rollback execution
- Ignore rollback until a later milestone

Auto decision:
- Store rollback candidates with enough prior/target state for operator review, but do not build automatic identity rollback in this phase.

Reason:
- The roadmap asks for rollback candidates, not full reversible SCIM orchestration.

### Activity Log And Readiness

Options considered:
- Reuse activity log with new rollout actions (selected)
- Create an unrelated audit system
- Only return apply results to the caller

Auto decision:
- Add rollout-specific activity actions and connect apply evidence to existing readiness/evidence aggregation.

Reason:
- Existing rollout code already uses `activity_log` and `getRolloutAuditLog`; extending it preserves established operator audit behavior.

### Operator Surface

Options considered:
- Extend `EnterpriseRolloutPage` (selected)
- Create a new dashboard
- Backend-only apply API

Auto decision:
- Extend the existing enterprise rollout page with apply controls, result rows, rollback candidates, and audit evidence.

Reason:
- Operators already use this page for SSO validation, SCIM preview, readiness, and audit log.

### Deterministic Verification

Options considered:
- Deterministic route/service tests with fixtures (selected)
- Live IdP/SCIM provider tests as default
- Manual-only verification

Auto decision:
- Default verification must avoid external network and cover success/failure/partial/rollback candidate paths with fixtures and fallback route-contract tests.

Reason:
- AGENTS.md and project history require deterministic local/CI behavior, with embedded Postgres skips documented on unsupported Windows hosts.

## Scope Boundaries

- Full SSO login runtime is out of scope.
- Mandatory live IdP metadata fetch is out of scope.
- Automatic identity rollback execution is out of scope.
- Phase 40-43 topics are explicitly deferred.

## External Research

No external research was performed during discussion. The needed context is project-local: Phase 20 decisions, existing enterprise rollout code, and v2.6 requirements.
