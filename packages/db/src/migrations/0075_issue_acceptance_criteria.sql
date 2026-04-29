CREATE TABLE IF NOT EXISTS "issue_acceptance_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"position" integer DEFAULT 0 NOT NULL,
	"evidence_work_product_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"resolved_by_run_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_company_id_companies_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_issue_id_issues_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_evidence_work_product_id_issue_work_products_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_evidence_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("evidence_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_resolved_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_acceptance_criteria_resolved_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_acceptance_criteria" ADD CONSTRAINT "issue_acceptance_criteria_resolved_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("resolved_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_acceptance_criteria_company_issue_position_idx" ON "issue_acceptance_criteria" USING btree ("company_id","issue_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_acceptance_criteria_company_issue_state_idx" ON "issue_acceptance_criteria" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_acceptance_criteria_evidence_idx" ON "issue_acceptance_criteria" USING btree ("evidence_work_product_id");
