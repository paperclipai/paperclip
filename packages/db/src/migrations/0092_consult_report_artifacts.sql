CREATE TABLE IF NOT EXISTS "consult_report_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"accountable_issue_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_comment_id" uuid,
	"source_document_id" uuid,
	"source_document_key" text,
	"decision" text NOT NULL,
	"evidence" text NOT NULL,
	"risk" text NOT NULL,
	"next_owner_text" text NOT NULL,
	"next_owner_agent_id" uuid,
	"next_owner_user_id" text,
	"next_owner_issue_id" uuid,
	"report_needed" boolean DEFAULT false NOT NULL,
	"report_reason" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_report_artifacts_source_type_check" CHECK ("source_type" IN ('issue', 'comment', 'document')),
	CONSTRAINT "consult_report_artifacts_report_reason_check" CHECK ("report_needed" = false OR length(btrim(coalesce("report_reason", ''))) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_company_id_companies_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_source_issue_id_issues_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_accountable_issue_id_issues_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_accountable_issue_id_issues_id_fk" FOREIGN KEY ("accountable_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_source_comment_id_issue_comments_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_source_document_id_documents_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_next_owner_agent_id_agents_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_next_owner_agent_id_agents_id_fk" FOREIGN KEY ("next_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_next_owner_issue_id_issues_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_next_owner_issue_id_issues_id_fk" FOREIGN KEY ("next_owner_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consult_report_artifacts_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "consult_report_artifacts" ADD CONSTRAINT "consult_report_artifacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_report_artifacts_company_source_issue_created_idx" ON "consult_report_artifacts" USING btree ("company_id","source_issue_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_report_artifacts_company_accountable_issue_created_idx" ON "consult_report_artifacts" USING btree ("company_id","accountable_issue_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consult_report_artifacts_company_report_needed_created_idx" ON "consult_report_artifacts" USING btree ("company_id","report_needed","created_at");
