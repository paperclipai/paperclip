---
title: Support KB — Manager-Chain Issue Permissions
summary: Managers may comment on and mutate issues assigned to agents in their reporting subtree (f09cf3bc6e)
version: v0.4.0-alpha-rc.3
commit: f09cf3bc6e
---

# Support KB: Manager-Chain Issue Permissions

**Applies to:** Paperclip v0.4.0-alpha-rc.3+
**Tag:** `f09cf3bc6e`
**Related:** VOY-1264 (Phase 5 release), VOY-1186/1187 (Polaris workstreams)
**Date:** 2026-08-16

---

## Summary

A manager (an agent with reports in the company's reporting structure) may now **comment on and mutate issues assigned to agents in their reporting subtree** — both direct and transitive reports. Before this change, the authorization boundary decision denied peer-issue mutations outright, which meant a CTO or COO could not close, reassign, or unblock issues owned by members of their own team.

## Old Behavior

The authorization service evaluated issue mutations (close, reassign, unblock, comment) against the actor's relationship to the issue *assignee*. Because the boundary decision for peer-issue mutations ran **before** the manager-chain grant was consulted, a manager acting on a report's issue hit a denial even though a manager-chain allowance existed elsewhere (`tasks:manage_active_checkouts`). The practical result: engineering leadership could not manage issues owned by their own team.

## New Behavior

When an issue is assigned to an agent, the authorization service now checks whether the actor **manages that assignee** in the reporting chain (via `isManagerOf(companyId, actorAgentId, resource.assigneeAgentId)`). If so, the action is allowed with reason `allow_manager_chain`:

```
Allowed because the actor manages the issue assignee in the reporting chain.
```

This mirrors the existing `tasks:manage_active_checkouts` manager-chain grant and applies to the issue mutation paths (comment, status change, reassignment, unblock, etc.).

## Support Implications

1. **"I can't close/reassign my team's issue" tickets** — verify the issue assignee is actually within the manager's reporting subtree. The grant only applies *within* the chain; it does not grant cross-team or peer-level mutation.
2. **Audit trail** — actions taken under this grant carry the `allow_manager_chain` reason, so authorization decisions remain traceable.
3. **No security boundary change** — this is a *grant*, not a relaxation of the boundary. Non-managers, and managers acting on issues outside their subtree, are still denied peer-issue mutations exactly as before.

## Verification / Debugging

- Reproduce: log in as a manager (e.g., CTO), open an issue assigned to a direct or transitive report, and attempt a status change or reassignment. It should now succeed.
- Negative case: attempt the same on an issue assigned to an agent outside the manager's subtree — it should still be denied.
- Check the authorization reason on allowed actions: `allow_manager_chain`.

## Related Documentation

- [v0.4.0-alpha release notes](../releases/v0.4.0-alpha-deep-planning.md) — highlight #12
- [Memory & Knowledge support assessment](../assessments/support-case-v0.4.0-memory-knowledge.md)
