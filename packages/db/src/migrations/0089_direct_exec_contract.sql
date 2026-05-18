CREATE TABLE IF NOT EXISTS "direct_exec_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid,
  "origin_kind" text DEFAULT 'direct_exec' NOT NULL,
  "origin_id" text NOT NULL,
  "origin_run_id" text,
  "dedupe_key" text NOT NULL,
  "source_channel" text NOT NULL,
  "source_chat_id" text NOT NULL,
  "source_message_id" text NOT NULL,
  "sender_id" text NOT NULL,
  "target_alias" text NOT NULL,
  "visibility" text NOT NULL,
  "lifecycle_status" text DEFAULT 'accepted' NOT NULL,
  "lifecycle" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'direct_exec_threads_company_id_companies_id_fk') THEN
    ALTER TABLE "direct_exec_threads" ADD CONSTRAINT "direct_exec_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'direct_exec_threads_issue_id_issues_id_fk') THEN
    ALTER TABLE "direct_exec_threads" ADD CONSTRAINT "direct_exec_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "direct_exec_threads_company_dedupe_uq" ON "direct_exec_threads" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "direct_exec_threads_company_origin_uq" ON "direct_exec_threads" USING btree ("company_id","origin_kind","origin_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "direct_exec_threads_company_source_uq" ON "direct_exec_threads" USING btree ("company_id","source_channel","source_chat_id","source_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_exec_threads_company_status_idx" ON "direct_exec_threads" USING btree ("company_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_exec_threads_issue_idx" ON "direct_exec_threads" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_exec_threads_origin_kind_check_idx" ON "direct_exec_threads" USING btree ("company_id","origin_kind") WHERE "direct_exec_threads"."origin_kind" = 'direct_exec';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_direct_exec_origin_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'direct_exec' AND "issues"."origin_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "direct_exec_context_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "direct_exec_thread_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "sources" jsonb NOT NULL,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "conflicts" jsonb NOT NULL,
  "answer_category" text,
  "answer_evidence" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'direct_exec_context_bundles_company_id_companies_id_fk') THEN
    ALTER TABLE "direct_exec_context_bundles" ADD CONSTRAINT "direct_exec_context_bundles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'direct_exec_context_bundles_direct_exec_thread_id_direct_exec_threads_id_fk') THEN
    ALTER TABLE "direct_exec_context_bundles" ADD CONSTRAINT "direct_exec_context_bundles_direct_exec_thread_id_direct_exec_threads_id_fk" FOREIGN KEY ("direct_exec_thread_id") REFERENCES "public"."direct_exec_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'direct_exec_context_bundles_issue_id_issues_id_fk') THEN
    ALTER TABLE "direct_exec_context_bundles" ADD CONSTRAINT "direct_exec_context_bundles_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_exec_context_bundles_thread_updated_idx" ON "direct_exec_context_bundles" USING btree ("direct_exec_thread_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "direct_exec_context_bundles_company_issue_idx" ON "direct_exec_context_bundles" USING btree ("company_id","issue_id");
