-- GitHub tables may already exist on a preview instance that applied the
-- earlier migration number. Preserve those tables, records, and constraints.
CREATE TABLE IF NOT EXISTS "chat_github_configurations" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"configuration" jsonb NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_config_revision_check" CHECK ("chat_github_configurations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_github_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"trusted_origin" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_registration_status_check" CHECK ("chat_github_registrations"."status" in ('pending', 'exchanging', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_github_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"delivery_id" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"event" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"assessment" jsonb,
	"conclusion" text,
	"check_id" text,
	"check_url" text,
	"summary_id" text,
	"summary_url" text,
	"publication_receipts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_reviews_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_github_review_pull_number_check" CHECK ("chat_github_reviews"."pull_number" > 0),
	CONSTRAINT "chat_github_review_state_check" CHECK ("chat_github_reviews"."state" in ('queued', 'running', 'completed', 'incomplete', 'error', 'superseded', 'manual_required'))
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_github_configurations" ADD CONSTRAINT "chat_github_configurations_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_github_registrations" ADD CONSTRAINT "chat_github_registrations_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_github_reviews" ADD CONSTRAINT "chat_github_reviews_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_github_registration_state_uq" ON "chat_github_registrations" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_github_registration_endpoint_idx" ON "chat_github_registrations" USING btree ("endpoint_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_github_reviews_delivery_uq" ON "chat_github_reviews" USING btree ("endpoint_id","delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_github_reviews_pull_idx" ON "chat_github_reviews" USING btree ("endpoint_id","repository_id","pull_number","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_github_reviews_task_idx" ON "chat_github_reviews" USING btree ("company_id","issue_id","run_id");