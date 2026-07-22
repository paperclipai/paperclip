DROP INDEX IF EXISTS "cost_events_heartbeat_run_unique_idx";

CREATE UNIQUE INDEX "cost_events_heartbeat_run_model_unique_idx"
  ON "cost_events" ("heartbeat_run_id", "provider", "biller", "billing_type", "model")
  WHERE "heartbeat_run_id" IS NOT NULL;
