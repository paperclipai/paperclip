ALTER TYPE "public"."issue_status" ADD VALUE IF NOT EXISTS 'failed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_antecedents" (
	"issue_id" uuid NOT NULL,
	"antecedent_issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_antecedents_pk" PRIMARY KEY("issue_id","antecedent_issue_id"),
	CONSTRAINT "issue_antecedents_self_chk" CHECK (issue_id <> antecedent_issue_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"info" text,
	"template_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_set_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_set_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"template_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"record_kind" text NOT NULL,
	"record_id" text NOT NULL,
	"role" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_links_owner_kind_chk" CHECK (owner_kind IN ('issue', 'task_set')),
	CONSTRAINT "record_links_record_kind_chk" CHECK (record_kind IN ('loan', 'company', 'person', 'loan_tape', 'investment_deal'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_antecedents" ADD CONSTRAINT "issue_antecedents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_antecedents" ADD CONSTRAINT "issue_antecedents_antecedent_issue_id_issues_id_fk" FOREIGN KEY ("antecedent_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_sets" ADD CONSTRAINT "task_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_sets" ADD CONSTRAINT "task_sets_template_id_task_sets_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_sets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_sets" ADD CONSTRAINT "task_sets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_set_members" ADD CONSTRAINT "task_set_members_task_set_id_task_sets_id_fk" FOREIGN KEY ("task_set_id") REFERENCES "public"."task_sets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_set_members" ADD CONSTRAINT "task_set_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_set_members" ADD CONSTRAINT "task_set_members_template_issue_id_issues_id_fk" FOREIGN KEY ("template_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "record_links" ADD CONSTRAINT "record_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "record_links" ADD CONSTRAINT "record_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_antecedents_antecedent_idx" ON "issue_antecedents" USING btree ("antecedent_issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_sets_company_idx" ON "task_sets" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_sets_company_template_idx" ON "task_sets" USING btree ("company_id","template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_set_members_set_idx" ON "task_set_members" USING btree ("task_set_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_set_members_issue_idx" ON "task_set_members" USING btree ("issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_set_members_set_issue_uq" ON "task_set_members" USING btree ("task_set_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_links_company_owner_idx" ON "record_links" USING btree ("company_id","owner_kind","owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_links_company_record_idx" ON "record_links" USING btree ("company_id","record_kind","record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "record_links_owner_record_uq" ON "record_links" USING btree ("company_id","owner_kind","owner_id","record_kind","record_id");
