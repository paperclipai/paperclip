CREATE TABLE "native_source_epochs" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_instance_id" text NOT NULL,
	"from_epoch" text NOT NULL,
	"next_epoch" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"final_ordinal" bigint NOT NULL,
	"transition" jsonb NOT NULL,
	CONSTRAINT "native_source_epochs_run_id_source_instance_id_from_epoch_pk" PRIMARY KEY("run_id","source_instance_id","from_epoch"),
	CONSTRAINT "native_source_epochs_ordinal_bound" CHECK ("native_source_epochs"."final_ordinal" > 0 and "native_source_epochs"."final_ordinal" <= 9007199254740991)
);
--> statement-breakpoint
DROP INDEX "heartbeat_run_events_run_source_seq_uq";--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" DROP CONSTRAINT "native_output_body_chunks_company_id_run_id_body_id_source_seq_pk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "source_epoch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD COLUMN "chunk_offset" bigint;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD COLUMN "chunk_sha256" text;--> statement-breakpoint
-- Backfill body-local locators from their canonical immutable event. Refuse
-- conflicting historical chunks; only exact duplicate content may coalesce.
UPDATE native_output_body_chunks c SET
  chunk_offset = (e.payload->'prpEvent'->'payload'->>'offset')::bigint,
  chunk_sha256 = e.payload->'prpEvent'->'payload'->>'sha256'
FROM heartbeat_run_events e WHERE e.id = c.event_id AND e.company_id = c.company_id AND e.run_id = c.run_id;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM native_output_body_chunks GROUP BY company_id, run_id, body_id, chunk_offset HAVING count(DISTINCT chunk_sha256) > 1)
    THEN RAISE EXCEPTION 'Conflicting historical output chunks'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM native_output_body_chunks a USING native_output_body_chunks b
WHERE a.company_id=b.company_id AND a.run_id=b.run_id AND a.body_id=b.body_id AND a.chunk_offset=b.chunk_offset
  AND a.chunk_sha256=b.chunk_sha256 AND a.event_id>b.event_id;
--> statement-breakpoint
ALTER TABLE native_output_body_chunks ALTER COLUMN chunk_offset SET NOT NULL, ALTER COLUMN chunk_sha256 SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_company_id_run_id_body_id_chunk_offset_pk" PRIMARY KEY("company_id","run_id","body_id","chunk_offset");--> statement-breakpoint
ALTER TABLE "native_source_cursors" ADD COLUMN "source_epoch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "native_source_epochs" ADD CONSTRAINT "native_source_epochs_run_owner_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_source_epochs_successor_uq" ON "native_source_epochs" USING btree ("run_id","source_instance_id","next_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "native_source_epochs_transition_uq" ON "native_source_epochs" USING btree ("run_id","source_instance_id","transition_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Replaces the existing exact replay uniqueness index atomically under the transactional migration runner; CONCURRENTLY cannot run here. This one-time maintenance migration must finish before admitting epoch writers; ordinary continuation never rebuilds it.
CREATE UNIQUE INDEX "heartbeat_run_events_run_source_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","source_instance_id","source_epoch","source_seq") WHERE "heartbeat_run_events"."source_instance_id" is not null and "heartbeat_run_events"."source_seq" is not null;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_offset_bound" CHECK ("native_output_body_chunks"."chunk_offset" >= 0 and "native_output_body_chunks"."chunk_offset" < 4194304);--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_hash_valid" CHECK ("native_output_body_chunks"."chunk_sha256" ~ '^[a-f0-9]{64}$');