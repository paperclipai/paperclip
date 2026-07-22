UPDATE "cost_events" AS ce
SET "cost_cents" = round(
  (coalesce(
    hr."usage_json" ->> 'costUsd',
    hr."usage_json" ->> 'cost_usd',
    hr."result_json" ->> 'costUsd',
    hr."result_json" ->> 'cost_usd'
  ))::numeric * 100,
  6
)
FROM "heartbeat_runs" AS hr
WHERE ce."heartbeat_run_id" = hr."id"
  AND ce."cost_cents" = 0
  AND ce."billing_type" <> 'subscription_included'
  AND coalesce(
    hr."usage_json" ->> 'costUsd',
    hr."usage_json" ->> 'cost_usd',
    hr."result_json" ->> 'costUsd',
    hr."result_json" ->> 'cost_usd'
  ) ~ '^[0-9]+([.][0-9]+)?$'
  AND (coalesce(
    hr."usage_json" ->> 'costUsd',
    hr."usage_json" ->> 'cost_usd',
    hr."result_json" ->> 'costUsd',
    hr."result_json" ->> 'cost_usd'
  ))::numeric > 0;
