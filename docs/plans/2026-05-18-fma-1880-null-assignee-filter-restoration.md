# FMA-1880 null-assignee issues filter restoration

## Scope

Restore the documented `assigneeAgentId=null` contract on Paperclip issue list routes so orphan sweeps can query unassigned issues without a client-side fallback.

## Plan

1. Add route regression coverage for `GET /api/companies/:companyId/issues` and `GET /api/companies/:companyId/issues/count`:
   - literal `"null"` normalizes to `assigneeAgentId: null`
   - malformed values return `422`
   - duplicate query values return `422`
2. Add service regression coverage proving:
   - `assigneeAgentId: null` maps to `IS NULL`
   - UUID assignee filtering still works
   - count mirrors list semantics
3. Implement a route helper that accepts exactly one assignee query token and only allows UUIDs or the literal `"null"`.
4. Update issue service filter semantics so `undefined` means no filter, `null` means unassigned, and a string means exact assignee match.
5. Run focused Vitest coverage for the new route and service regressions.
