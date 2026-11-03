CREATE TABLE "heartbeat_run_event_cursors" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_instance_id" text NOT NULL,
	"contiguous_source_seq" bigint DEFAULT 0 NOT NULL,
	"pending_range_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "heartbeat_run_event_cursors_company_id_run_id_source_instance_id_pk" PRIMARY KEY("company_id","run_id","source_instance_id"),
	CONSTRAINT "heartbeat_run_event_cursors_nonnegative" CHECK ("heartbeat_run_event_cursors"."contiguous_source_seq" >= 0 and "heartbeat_run_event_cursors"."pending_range_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "heartbeat_run_event_source_ranges" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_instance_id" text NOT NULL,
	"start_seq" bigint NOT NULL,
	"end_seq" bigint NOT NULL,
	CONSTRAINT "heartbeat_run_event_source_ranges_company_id_run_id_source_instance_id_start_seq_pk" PRIMARY KEY("company_id","run_id","source_instance_id","start_seq"),
	CONSTRAINT "heartbeat_run_event_source_ranges_positive" CHECK ("heartbeat_run_event_source_ranges"."start_seq" >= 1 and "heartbeat_run_event_source_ranges"."end_seq" >= "heartbeat_run_event_source_ranges"."start_seq")
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "event_cursor_projection_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "event_cursor_rebuild_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_cursors" ADD CONSTRAINT "heartbeat_run_event_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_cursors" ADD CONSTRAINT "heartbeat_run_event_cursors_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_event_source_ranges" ADD CONSTRAINT "heartbeat_run_event_source_ranges_cursor_fk" FOREIGN KEY ("company_id","run_id","source_instance_id") REFERENCES "public"."heartbeat_run_event_cursors"("company_id","run_id","source_instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_event_cursor_rebuild_idx" ON "heartbeat_runs" USING btree ("company_id","id") WHERE "heartbeat_runs"."event_cursor_rebuild_pending" = true;