---
title: Support KB — Recovery Phantom-Park-and-Revalidate Protocol
summary: Recovery temporarily parks terminal issues for recovery action execution (RBR-921 AC3 / RBR-953)
version: v0.3.1+
commit: 7f84af039b
---

# Support KB: Recovery Phantom-Park-and-Revalidate Protocol

**Applies to:** Paperclip v0.3.1+
**Commit:** `7f84af039b` (RBR-921 AC3 / RBR-953 / RBR-824)
**Date:** 2026-08-15

---

## Summary

The Paperclip recovery system uses a "phantom-park-and-revalidate" protocol to handle recovery actions on issues that are already in a terminal state (done/cancelled).

## What It Does

When a recovery action runs against an issue that's already `done` or `cancelled`:

1. **Park:** The recovery system temporarily sets the issue status to `blocked` (the "park"), even though it's terminal. This is intentional — it allows the recovery action to proceed.
2. **Revalidate:** The next read projection of the issue detects the terminal-state mismatch and **reverts** the status back to its original terminal state.
3. **Result:** The recovery action executes, the issue appears to briefly flash to `blocked`, then immediately reverts to `done`/`cancelled`. All state changes are auditable.

## Why It Exists

Some recovery scenarios require the issue to not be terminal for the recovery logic to work (e.g., assigning a new owner, adding a comment, updating recovery metadata). The phantom-park allows this while ensuring the terminal state is preserved in the projection layer.

## What This Means for Support

- **You may see issues briefly flash to `blocked`** and back to `done`/`cancelled` — this is expected behavior from the phantom-park protocol
- **No data loss** — the original terminal status is preserved and restored
- **The `allowTerminalReopen: true` flag** in the recovery service enables this; it's only used for recovery actions, never for user-initiated status changes
- If you see an issue stuck in `blocked` that should be terminal, check if a recovery action is still active on it

## How to Verify

1. Check the issue's `activeRecoveryAction` field — if present with `status=active`, a recovery action is in progress
2. Check audit logs for the status transition (`done` → `blocked` → `done`)
3. If stuck, resolve or cancel the recovery action via the recovery admin endpoint

## Related

- RBR-921: recovery revalidation must revert the park it invalidated
- RBR-953: terminal-reopen gate must allow recovery protocol
- `server/src/services/recovery/service.ts` — `allowTerminalReopen` implementation
