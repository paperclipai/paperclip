---
title: Support KB — Child-Only Blocker Reclassification
summary: Blocked issues with only child blockers now classify as needs_attention (RBR-824)
version: v0.3.1+
commit: 6b0b118367 + 7f84af039b
---

# Support KB: Child-Only Blocker Reclassification

**Applies to:** Paperclip v0.3.1+
**Commits:** `6b0b118367` (initial fix) + `7f84af039b` (counter fix)
**Date:** 2026-08-15

---

## Summary

When a blocked issue's **only** top-level blockers are its own child issues (created as remediation/unblock attempts), the blocker engine now classifies the parent as `needs_attention` instead of `covered`. The counter fields are also recomputed to match the new state.

## Old Behavior

If all top-level blockers of a blocked issue were its own children, the `blockerAttention` state was set to `"covered"` with reason `"active_child"`. This meant a blocked parent with child-only blockers (e.g., remediation issues created to unblock it) appeared as "handled" when it wasn't — the children were unblock attempts, not actual dependencies being resolved.

## New Behavior

When all top-level blockers are children of the blocked issue:

| Field | Old Value | New Value |
|---|---|---|
| `state` | `"covered"` | `"needs_attention"` |
| `reason` | `"active_child"` | `"attention_required"` |
| `coveredBlockerCount` | counts children as covered | `0` |
| `stalledBlockerCount` | unchanged | unchanged |
| `attentionBlockerCount` | `total - covered - stalled` | `= topLevelEdges.length` (all children become attention) |

All children that were counted as covered blockers are reclassified as attention blockers. This ensures the parent is not misrepresented as handled when its only blockers are its own unblock-attempt children.

## Why This Matters

Agents and users rely on `blockerAttention.state` to decide what needs action. A parent showing `covered` when it's actually stuck in a self-referencing blocker loop (PRA-121 → PRA-346/354/360) misleads triage. The reclassification ensures blocked parents with only child-blockers surface as needing human or automation attention.

## What This Means for Support

- **If you see a blocked issue with `state: "needs_attention"` and `reason: "attention_required"`** and its only blockers are its own children, this is correct behavior — the parent genuinely needs attention
- **If you were relying on `reason: "active_child"`** in automation, update your logic to check `state === "covered"` with `reason === "active_dependency"` for explicit blockers, or check whether the blocker has a `source` field
- **The `sampleBlockerIdentifier`** in `blockerAttention` will point to the first non-covered, non-stalled blocker — or if all children are reclassified, to the first child

## How to Verify

1. Query an issue's `blockerAttention` via the API
2. If `state === "needs_attention"` and the issue has child issues that are also blockers, check whether those children are unblock-attempt tasks
3. To verify the fix is active, check that `coveredBlockerCount` is `0` and `attentionBlockerCount > 0` when only child-blockers exist

## Related

- PRA-370: child-creates-blocker cycle prevention
- RBR-824: recompute attention counts on child-only reclassification
- Commit `6b0b118367`: initial classification change
- Commit `7f84af039b`: counter consistency fix
- `server/src/services/issues.ts` — `listIssueBlockerAttentionMap`
