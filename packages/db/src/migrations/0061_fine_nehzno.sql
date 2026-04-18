ALTER TABLE "heartbeat_runs" ADD COLUMN "last_activity_at" timestamp with time zone;
UPDATE "heartbeat_runs"
SET "last_activity_at" = COALESCE("last_activity_at", "updated_at", "started_at", "created_at")
WHERE "last_activity_at" IS NULL;
