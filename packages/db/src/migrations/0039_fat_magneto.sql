CREATE TABLE IF NOT EXISTS "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text,
	"trigger_payload" jsonb,
	"linked_issue_id" uuid,
	"coalesced_into_run_id" uuid,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routine_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"public_id" text,
	"secret_id" uuid,
	"signing_mode" text,
	"replay_window_sec" integer,
	"last_rotated_at" timestamp with time zone,
	"last_result" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid,
	"parent_issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_agent_id" uuid NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"concurrency_policy" text DEFAULT 'coalesce_if_active' NOT NULL,
	"catch_up_policy" text DEFAULT 'skip_missed' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"last_triggered_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_run_id" text;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_company_id_companies_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_routine_id_routines_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_trigger_id_routine_triggers_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_linked_issue_id_issues_id_fk') THEN
  ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_company_id_companies_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_routine_id_routines_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_secret_id_company_secrets_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_triggers_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_company_id_companies_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_project_id_projects_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_goal_id_goals_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_parent_issue_id_issues_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_assignee_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_company_routine_idx" ON "routine_runs" USING btree ("company_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_trigger_idx" ON "routine_runs" USING btree ("trigger_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_linked_issue_idx" ON "routine_runs" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_trigger_idempotency_idx" ON "routine_runs" USING btree ("trigger_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_triggers_company_routine_idx" ON "routine_triggers" USING btree ("company_id","routine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_triggers_company_kind_idx" ON "routine_triggers" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_triggers_next_run_idx" ON "routine_triggers" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_triggers_public_id_idx" ON "routine_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_status_idx" ON "routines" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_assignee_idx" ON "routines" USING btree ("company_id","assignee_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_project_idx" ON "routines" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_origin_idx" ON "issues" USING btree ("company_id","origin_kind","origin_id");
