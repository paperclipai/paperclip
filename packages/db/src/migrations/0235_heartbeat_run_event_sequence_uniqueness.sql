WITH ranked AS (
	SELECT
		"id",
		"run_id",
		"seq",
		row_number() OVER (PARTITION BY "run_id", "seq" ORDER BY "id") AS duplicate_ordinal,
		max("seq") OVER (PARTITION BY "run_id") AS max_seq
	FROM "heartbeat_run_events"
), duplicates AS (
	SELECT
		"id",
		max_seq + row_number() OVER (PARTITION BY "run_id" ORDER BY "seq", "id") AS repaired_seq
	FROM ranked
	WHERE duplicate_ordinal > 1
)
UPDATE "heartbeat_run_events" AS event
SET "seq" = duplicates.repaired_seq
FROM duplicates
WHERE event."id" = duplicates."id";--> statement-breakpoint
UPDATE "heartbeat_runs" AS run
SET "next_event_seq" = COALESCE((
	SELECT max(event."seq") + 1
	FROM "heartbeat_run_events" AS event
	WHERE event."run_id" = run."id"
), 1);--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The duplicate repair and uniqueness invariant must commit atomically before native event writers rely on the sequence key.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","seq");--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_run_events_run_seq_idx";
