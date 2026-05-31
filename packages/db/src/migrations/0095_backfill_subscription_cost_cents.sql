-- Backfill cost_cents from usage_json.costUsd for subscription billing events
-- where cost_cents was incorrectly set to 0 due to string/number type mismatch
UPDATE cost_events
SET cost_cents = GREATEST(0, ROUND((heartbeat_runs.usage_json ->> 'costUsd')::numeric * 100)::int)
FROM heartbeat_runs
WHERE cost_events.heartbeat_run_id = heartbeat_runs.id
  AND cost_events.billing_type IN ('subscription_included', 'subscription_overage')
  AND cost_events.cost_cents = 0
  AND heartbeat_runs.usage_json ->> 'costUsd' IS NOT NULL
  AND (heartbeat_runs.usage_json ->> 'costUsd')::numeric > 0;
