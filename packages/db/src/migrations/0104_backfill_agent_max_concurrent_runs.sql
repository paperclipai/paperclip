-- Backfill heartbeat.maxConcurrentRuns = 3 for all existing agents.
-- Caps per-agent concurrency to 3 so the instance-level gate (default 10) has
-- headroom on the current 10 GB host. New agents already default to 3 via the
-- agent create route; this migration brings existing agents into line.
UPDATE "agents"
SET
  "runtime_config" = jsonb_set(
    COALESCE("runtime_config", '{}'::jsonb),
    '{heartbeat,maxConcurrentRuns}',
    '3'::jsonb,
    true
  ),
  "updated_at" = now();
