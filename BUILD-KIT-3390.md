# BUILD for KIT-3390

## PR
No PR — work on `local-custom` branch, never upstream.

## Commits
- `9c6131c9` — fix(db): align agent_context_cache schema with migration (text -> jsonb)
- `c997e842` — Fix migration journal ordering and issues.ts type error (Phase 0.8 context cache schema and migration)

## Files changed
- `packages/db/src/migrations/0071_context_cache.sql` (+112L)
- `packages/db/src/schema/agent_context_cache.ts` (+27L)
- `packages/db/src/schema/index.ts` (+1L)
- `packages/db/src/migrations/meta/_journal.json` (+23L)
- `server/src/services/heartbeat.ts` (+204L/-22L)
- `server/src/onboarding-assets/ceo/AGENTS.md` (+8L)
- `server/src/onboarding-assets/default/AGENTS.md` (+8L)

## Compile / Typecheck
```
server typecheck$ pnpm --filter @paperclipai/plugin-sdk build && tsc --noEmit
...
server typecheck: Done
```
Typecheck passed.

## Local tests
```
Note: local tests are NOT proof. CI must run to validate.
No tests were modified as part of this build.
```

## CI
No CI run — `local-custom` branch does not run GitHub Actions.
This is a private customization branch, not merged to upstream.

## Deviations from SPEC
- Schema uses `jsonb` for `last_context` column (matching migration) rather than `text`. The issue description said `jsonb` for `last_context` and the schema was updated to match.
- No PR created since work stays on `local-custom` branch (per issue: "Never upstream").

## Remaining Risks
- The context cache invalidation logic relies on `txid_current_snapshot()` comparison. If PostgreSQL MVCC semantics don't provide the expected invalidation behavior, the cache might become stale without detection.
- The 100KB compressed cap is enforced after compression. If compression is ineffective, large contexts will always spill to summary + fetch_on_demand.
- Cache cleanup (deleting expired caches) requires periodic invocation of `cleanup_expired_context_caches()` function — no cron/scheduler task has been set up yet.

## Implementation Summary

### What was built
- New `agent_context_cache` table with columns: `agent_id`, `last_context` (jsonb), `last_loaded_at`, `cached_at_xact_id`, `expires_at`, `fetch_on_demand`, `summary`
- 1h TTL on cache entries
- PostgreSQL helper functions for cache operations: `get_or_create_agent_context_cache`, `is_context_cache_fresh`, `is_context_cache_expired`, `invalidate_agent_context_cache`, `update_agent_context_cache`, `cleanup_expired_context_caches`
- Context cache service functions in heartbeat.ts: `getCachedAgentContext`, `setCachedAgentContext`, `invalidateCachedAgentContext`
- Cache check integrated into heartbeat run processing (before calling `buildPaperclipWakePayload`)
- gzip compression with 100KB cap; overflow spills to LLM-generated summary with `fetch_on_demand = true`

### How it works
1. On heartbeat wake, check if valid cached context exists for agent
2. If cache hit and not fetch_on_demand, use cached compiled context directly (saves DB queries)
3. If cache miss or fetch_on_demand, call `buildPaperclipWakePayload` to fetch fresh data, then cache result
4. Cache invalidated by TTL expiry or transaction ID change (detected via `txid_current_snapshot()` comparison)
