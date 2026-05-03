CREATE TABLE IF NOT EXISTS "agent_failure_state" (
  "agent_id" uuid PRIMARY KEY NOT NULL,
  "consecutive_adapter_failures" integer DEFAULT 0 NOT NULL,
  "first_failure_run_id" uuid,
  "last_failure_run_id" uuid,
  "open_auto_issue_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_failure_state" ADD CONSTRAINT "agent_failure_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_failure_state" ADD CONSTRAINT "agent_failure_state_first_failure_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("first_failure_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_failure_state" ADD CONSTRAINT "agent_failure_state_last_failure_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_failure_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_failure_state" ADD CONSTRAINT "agent_failure_state_open_auto_issue_id_issues_id_fk" FOREIGN KEY ("open_auto_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_agent_finished_idx" ON "heartbeat_runs" USING btree ("agent_id","finished_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_adapter_failure_idempotency_uq" ON "issues" ("idempotency_key") WHERE "idempotency_key" LIKE 'auto-adapter-failure:%';
