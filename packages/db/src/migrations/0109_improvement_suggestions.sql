CREATE TABLE IF NOT EXISTS "improvement_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"origin_kind" text NOT NULL,
	"status" text NOT NULL,
	"target_layer" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"proposed_change" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_issue_id" uuid,
	"source_run_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"reviewed_by_user_id" text,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_company_id_companies_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_source_issue_id_issues_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_source_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "improvement_suggestions_company_status_idx" ON "improvement_suggestions" USING btree ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "improvement_suggestions_company_origin_idx" ON "improvement_suggestions" USING btree ("company_id", "origin_kind", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "improvement_suggestions_source_issue_idx" ON "improvement_suggestions" USING btree ("company_id", "source_issue_id");
