-- `adapterConfig.maxConcurrentRuns` was a silently accepted no-op: nothing in the platform ever
-- read the adapter copy. The admission cap comes from
-- `runtimeConfig.heartbeat.maxConcurrentRuns` (server/src/services/heartbeat/queue.ts,
-- parseHeartbeatPolicy). The write paths now accept the key as a deprecated alias, store it under
-- runtimeConfig, and never persist it on the adapter. This one-shot UPDATE removes the stale
-- copies that predate that change. It is behaviour-neutral because the key has no reader.
UPDATE "agents"
SET "adapter_config" = "adapter_config" - 'maxConcurrentRuns'
WHERE "adapter_config" ? 'maxConcurrentRuns';
