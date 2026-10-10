CREATE TABLE IF NOT EXISTS "issue_watchdogs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "watchdog_agent_id" uuid NOT NULL,
  "instructions" text,
  "status" text DEFAULT 'active' NOT NULL,
  "watchdog_issue_id" uuid,
  "last_observed_fingerprint" text,
  "last_reviewed_fingerprint" text,
  "last_triggered_at" timestamp with time zone,
  "last_completed_at" timestamp with time zone,
  "trigger_count" integer DEFAULT 0 NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "updated_by_agent_id" uuid,
  "updated_by_user_id" text,
  "updated_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_watchdog_agent_id_agents_id_fk" FOREIGN KEY ("watchdog_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_watchdog_issue_id_issues_id_fk" FOREIGN KEY ("watchdog_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_updated_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("updated_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_watchdogs_company_issue_uq"
  ON "issue_watchdogs" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdogs_company_status_idx"
  ON "issue_watchdogs" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdogs_company_agent_idx"
  ON "issue_watchdogs" USING btree ("company_id","watchdog_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_watchdogs_company_watchdog_issue_uq"
  ON "issue_watchdogs" USING btree ("company_id","watchdog_issue_id")
  WHERE "watchdog_issue_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_task_watchdog_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'task_watchdog'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
