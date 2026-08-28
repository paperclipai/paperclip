CREATE TABLE IF NOT EXISTS "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"case_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"case_type" text NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_case_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('draft', 'in_progress', 'in_review', 'approved', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_issue_links_role_check" CHECK ("case_issue_links"."role" in ('origin', 'work', 'reference'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
		'created',
		'updated',
		'fields_changed',
		'status_changed',
		'issue_linked',
		'issue_unlinked',
		'document_revised',
		'child_linked',
		'attachment_added',
		'label_added',
		'label_removed'
	)),
	CONSTRAINT "case_events_actor_type_check" CHECK ("case_events"."actor_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_parent_case_id_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cases" ADD CONSTRAINT "cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cases_company_case_number_uq" ON "cases" USING btree ("company_id","case_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cases_identifier_uq" ON "cases" USING btree ("identifier");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cases_company_type_key_uq" ON "cases" USING btree ("company_id","case_type","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_company_status_idx" ON "cases" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_company_type_idx" ON "cases" USING btree ("company_id","case_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_company_project_idx" ON "cases" USING btree ("company_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_parent_idx" ON "cases" USING btree ("parent_case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_title_search_idx" ON "cases" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_identifier_search_idx" ON "cases" USING gin ("identifier" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_summary_search_idx" ON "cases" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_issue_links_case_issue_uq" ON "case_issue_links" USING btree ("case_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_issue_links_company_case_idx" ON "case_issue_links" USING btree ("company_id","case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_issue_links_issue_idx" ON "case_issue_links" USING btree ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_events_case_created_idx" ON "case_events" USING btree ("case_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_events_company_case_idx" ON "case_events" USING btree ("company_id","case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_documents_company_case_key_uq" ON "case_documents" USING btree ("company_id","case_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_documents_document_uq" ON "case_documents" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_documents_company_case_updated_idx" ON "case_documents" USING btree ("company_id","case_id","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_labels_case_label_uq" ON "case_labels" USING btree ("case_id","label_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_labels_company_case_idx" ON "case_labels" USING btree ("company_id","case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_labels_label_idx" ON "case_labels" USING btree ("label_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_attachments_company_case_idx" ON "case_attachments" USING btree ("company_id","case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_attachments_asset_uq" ON "case_attachments" USING btree ("asset_id");
