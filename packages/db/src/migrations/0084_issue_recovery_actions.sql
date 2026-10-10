CREATE TABLE IF NOT EXISTS "issue_recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"recovery_issue_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_type" text DEFAULT 'agent' NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"previous_owner_agent_id" uuid,
	"return_owner_agent_id" uuid,
	"cause" text NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action" text NOT NULL,
	"wake_policy" jsonb,
	"monitor_policy" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer,
	"timeout_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"outcome" text,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_company_id_companies_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_source_issue_id_issues_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_recovery_issue_id_issues_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_recovery_issue_id_issues_id_fk" FOREIGN KEY ("recovery_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_previous_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_previous_owner_agent_id_agents_id_fk" FOREIGN KEY ("previous_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_return_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_return_owner_agent_id_agents_id_fk" FOREIGN KEY ("return_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_source_status_idx" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_owner_status_idx" ON "issue_recovery_actions" USING btree ("company_id","owner_agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_recovery_issue_idx" ON "issue_recovery_actions" USING btree ("company_id","recovery_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_source_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_fingerprint_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","cause","fingerprint") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');
