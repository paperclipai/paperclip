CREATE TABLE "native_output_body_chunks" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"body_id" text NOT NULL,
	"source_seq" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	CONSTRAINT "native_output_body_chunks_company_id_run_id_body_id_source_seq_pk" PRIMARY KEY("company_id","run_id","body_id","source_seq"),
	CONSTRAINT "native_output_body_chunks_body_id_valid" CHECK ("native_output_body_chunks"."body_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "native_output_body_chunks_sequence_positive" CHECK ("native_output_body_chunks"."source_seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_event_id_heartbeat_run_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."heartbeat_run_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_output_body_chunks" ADD CONSTRAINT "native_output_body_chunks_run_owner_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;