CREATE TABLE "native_run_process_evidence" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event_type" text,
	"process_pid" integer,
	"process_group_id" integer,
	CONSTRAINT "native_run_process_evidence_company_id_run_id_pk" PRIMARY KEY("company_id","run_id"),
	CONSTRAINT "native_run_process_evidence_event_valid" CHECK (("native_run_process_evidence"."seq" = 0 and "native_run_process_evidence"."event_type" is null) or ("native_run_process_evidence"."seq" > 0 and "native_run_process_evidence"."event_type" is not null and "native_run_process_evidence"."event_type" in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped')))
);
--> statement-breakpoint
ALTER TABLE "native_run_process_evidence" ADD CONSTRAINT "native_run_process_evidence_owner_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_output_body_chunks_event_idx" ON "native_output_body_chunks" USING btree ("event_id");