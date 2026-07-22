ALTER TABLE "agents"
  ALTER COLUMN "spent_monthly_cents" TYPE numeric(20, 6)
  USING "spent_monthly_cents"::numeric(20, 6);

ALTER TABLE "companies"
  ALTER COLUMN "spent_monthly_cents" TYPE numeric(20, 6)
  USING "spent_monthly_cents"::numeric(20, 6);

DELETE FROM "cost_events" AS duplicate
USING "cost_events" AS keeper
WHERE duplicate."heartbeat_run_id" = keeper."heartbeat_run_id"
  AND duplicate."heartbeat_run_id" IS NOT NULL
  AND (
    duplicate."created_at" > keeper."created_at"
    OR (duplicate."created_at" = keeper."created_at" AND duplicate."id" > keeper."id")
  );

CREATE UNIQUE INDEX "cost_events_heartbeat_run_unique_idx"
  ON "cost_events" ("heartbeat_run_id")
  WHERE "heartbeat_run_id" IS NOT NULL;
