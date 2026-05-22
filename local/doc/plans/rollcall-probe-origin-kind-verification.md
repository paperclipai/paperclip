# Verification Report: Rolecall Probe Origin Kind Implementation

This document verifies the successful implementation and stabilization of the `rollcall_probe` origin kind and the associated recovery infrastructure hardening, as outlined in [2026-05-05-rollcall-probe-origin-kind.md](./2026-05-05-rollcall-probe-origin-kind.md).

## 1. Implementation Summary

### Agent-Declarable Origin Guards
We implemented robust guards in the `recoveryService` to handle the `rollcall_probe` kind and other declarable origins (`skill:*`, `intent:*`).
- **Silent Cancellation**: Issues with these origin kinds are now silently cancelled upon failure in `reconcileStrandedAssignedIssues`, suppressing human escalation.
- **Liveness Isolation**: The liveness sweep now correctly excludes these transient tasks using robust SQL `NULL` and prefix-aware filtering.

### Liveness Classifier Hardening
- **Blocked-by-Nothing Detection**: Added explicit detection for issues marked as `blocked` but lacking actual relations. This ensures that while we exclude transient tasks, we don't ignore stalled human/agent tasks that are simply missing blockers.

## 2. Verification Results

### Automated Tests
The following integration tests have been successfully verified on the `HenkDz/paperclip` fork:

| Test Suite | Result | Summary |
| :--- | :--- | :--- |
| `recovery-origin-kind.test.ts` | **PASS** | Verified silent cancellation of declarable kinds and correct isolation in liveness findings. |
| `agent-rollcall.test.ts` | **PASS** | Verified that rollcall probes are correctly created with the `rollcall_probe` origin kind and handled correctly. |
| `issue-liveness.test.ts` | **PASS** | Verified recursive chain analysis, `blocked_by_nothing` detection, and deduplication of root findings. |
| `heartbeat-issue-liveness-escalation.test.ts` | **PASS** | Verified full liveness escalation lifecycle with finalized SQL filters. |

### Environment Stability
- **SSH Fixtures**: Stabilized via increased timeouts (30s) and GPG signing suppression to prevent CI/headless flakiness.
- **DB Fixtures**: Fixed foreign key constraint ordering and API drift in the test seeding logic.

## 3. Operational Notes
- The system now treats any origin kind prefixed with `skill:`, `intent:`, or `plugin:` as "agent-declarable" (non-recoverable).
- For manual inspection of these flows, refer to the `activityLog` with action `issue.silent_cancel_declarable_origin`.

---
**Date**: 2026-05-06  
**Status**: Verified & Stabilized
