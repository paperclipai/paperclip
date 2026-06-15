CREATE TABLE "heartbeat_run_log_chunks" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_log_chunks" ADD CONSTRAINT "heartbeat_run_log_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_log_chunks" ADD CONSTRAINT "heartbeat_run_log_chunks_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_run_log_chunks_run_seq_idx" ON "heartbeat_run_log_chunks" USING btree ("run_id","seq");