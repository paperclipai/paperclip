-- Repair legacy self-links in bounded batches using a temporary partial index.
-- Valid ancestor links and every other run field remain untouched.
CREATE INDEX "heartbeat_runs_self_retry_repair_idx" ON "heartbeat_runs" ("id")
WHERE "retry_of_run_id" = "id";--> statement-breakpoint
DO $$
DECLARE repaired integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT "id" FROM "heartbeat_runs"
      WHERE "retry_of_run_id" = "id"
      ORDER BY "id" LIMIT 1000
    )
    UPDATE "heartbeat_runs" AS runs SET "retry_of_run_id" = NULL
    FROM batch WHERE runs."id" = batch."id";
    GET DIAGNOSTICS repaired = ROW_COUNT;
    EXIT WHEN repaired = 0;
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX "heartbeat_runs_self_retry_repair_idx";--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_not_self_check" CHECK ("heartbeat_runs"."retry_of_run_id" is null or "heartbeat_runs"."retry_of_run_id" <> "heartbeat_runs"."id");