# Phase 20: Enterprise Rollout Connectors - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-25
**Phase:** 20-Enterprise Rollout Connectors
**Areas discussed:** SSO metadata validation, SCIM sync preview, rollout readiness and audit

## SSO Metadata Validation

| Option | Description | Selected |
|--------|-------------|----------|
| Preflight validation | Validate issuer, metadata URL, certificate expiry, callback URL without live IdP calls | yes |
| Live IdP handshake | Fetch provider metadata and test external auth handshake | |
| Save-only settings | Keep existing saved value evidence | |

**User's choice:** Auto-selected preflight validation for Phase 20 scope.
**Notes:** Live provider calls are deferred because the phase asks for 검수 가능한 rollout flow, not full auth runtime.

## SCIM Sync Preview

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only sync plan | Show create/update/deactivate candidates and warnings before apply | yes |
| Direct mutation | Apply SCIM changes immediately | |
| Documentation only | Record expected behavior without route/UI support | |

**User's choice:** Auto-selected read-only sync plan.
**Notes:** Deactivation is treated as high-risk and must be visible before apply.

## Rollout Readiness And Audit

| Option | Description | Selected |
|--------|-------------|----------|
| Unified readiness | Show SSO, SCIM, binding, policy validation and audit entries in one screen | yes |
| Separate screens | Split validation and audit into separate pages | |
| Evidence counters only | Keep current ready/partial/missing counters | |

**User's choice:** Auto-selected unified readiness.
**Notes:** This matches the existing `EnterpriseRolloutPage` operator workflow.

## the agent's Discretion

- Concrete validation heuristics and UI layout are delegated to implementation, bounded by existing RT2 enterprise patterns.

## Deferred Ideas

- Live SSO metadata fetch.
- Actual SCIM apply/mutation.
