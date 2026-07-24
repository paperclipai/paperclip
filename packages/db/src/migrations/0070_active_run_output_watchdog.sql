ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_stream" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_bytes" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_last_output_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","last_output_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_process_started_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","process_started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "heartbeat_run_watchdog_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "evaluation_issue_id" uuid,
  "decision" text NOT NULL,
  "snoozed_until" timestamp with time zone,
  "reason" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_evaluation_issue_id_issues_id_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_watchdog_decisions_company_run_created_idx"
  ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_watchdog_decisions_company_run_snooze_idx"
  ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","snoozed_until");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stale_run_evaluation_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'stale_active_run_evaluation'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
