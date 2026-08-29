# Add pre-dispatch credential quota gating and selection-time failover

Date: 2026-08-29
Status: planned — depends on the invokability seam from the upstream resync

## Problem

Credential quota exhaustion is currently discovered reactively: a run can start with an exhausted OAuth credential, fail, and only then fail over or retry. This burns time/tokens and produces noisy unavailable states even when another configured credential is usable.

## Design

Before dispatch, evaluate the selected credential using the fork's quota cache:

- fresh quota samples may allow dispatch
- a reusable exhausted/quota-blocked sample must block that credential
- recent provider errors may apply the existing cooldown policy without treating a healthy credential as permanently invalid
- stale successful samples remain visible but must not silently override a known quota block
- selection should try another compatible credential before creating a failed run
- if every credential is blocked, persist a typed quota reason and a scheduled wait/recovery path

Use the upstream invokability contract as the seam, but keep the fork's credential cache and rotation/failover behavior authoritative.

## Acceptance criteria

1. A known-exhausted credential is not dispatched.
2. A compatible credential with available quota is selected in the same dispatch attempt.
3. All credentials blocked by quota produce a typed, inspectable reason and no dead provider run.
4. Cache freshness, cooldown, stale sample, and concurrent-refresh behavior have server tests.
5. Board quota UI explains “blocked before dispatch” separately from “provider unavailable”.
6. No credential values or raw provider secrets appear in logs, activity, or errors.
