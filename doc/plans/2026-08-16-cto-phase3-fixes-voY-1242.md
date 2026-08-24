# CTO Execution Plan — VOY-1242 Phase 3 Fixes

## Sources

- VOY-1206 structural audit (Staff Engineer) — 10 findings
- Working tree already has partial fixes (binding UUID resolution, error-path scope, nullable bindingId, unique-constraint handling, delete returning)
- Need to complete, test, and commit the remaining items

## Priority breakdown

### Must-Fix (2)
1. **Broken warm-up**: `warmUpAgentMemory` calls `adapter.query({ query: "" })`. When embedding unavailable, falls to full-text with empty tsquery → Postgres error. Fix: handle empty query gracefully.
2. **sql.raw injection**: ✅ Already fixed in working tree (parameterized CAST($1 AS vector) + embedding validation + test)

### Should-Fix (5)
3. **tsquery safety**: `to_tsquery('english', ${tsQuery})` throws on special chars. Fix: sanitize or use `plainto_tsquery`.
4. **TTL**: Expired records returned in queries. Fix: add `expiresAt > now()` filter to all read queries. TTL cleanup job → deferred to child issue.
5. **Scope enforcement**: `buildScopeFilters` missing `subjectId` and `sessionKey`. Fix: add them.
6. **N+1 in upsertRecords**: Each record → separate DB insert + embedding API call. → Deferred to child issue (larger refactor).
7. **Missing composite index**: Add (company_id, binding_id) composite index. Migration 0133.

### Hardening (3)
8. **Preamble boundary**: Edge cases in `buildMemoryPreamble`. Fix: handle empty/null text, very long source refs.
9. **Hooks**: Post-run capture, issue comment capture not implemented. → Deferred to child issue (Phase 3 scope).
10. **Warm-up race**: `Promise.race` doesn't abort loser; background continuation wastes resources. Fix: AbortController pattern.

## Implementation Order

1. Fix broken warm-up (memory-context-injection.ts + tests)
2. Fix tsquery safety (memory-adapter.ts)
3. Add TTL filter to read queries (memory-adapter.ts)
4. Add missing scope dimensions (memory-adapter.ts)
5. Add composite index (migration 0133)
6. Preamble boundary hardening (memory-context-injection.ts + tests)
7. Fix warm-up race (memory-context-injection.ts)

### Deferred child issues
- VOY-1243: Fix N+1 in upsertRecords (batch inserts + embeddings)
- VOY-1244: Implement post-run/issue memory capture hooks
- VOY-1245: Add TTL cleanup cron job for expired memory records
