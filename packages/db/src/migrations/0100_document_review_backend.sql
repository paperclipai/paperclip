CREATE TABLE IF NOT EXISTS "document_review_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_key" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "resolved_by_agent_id" uuid,
  "resolved_by_user_id" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_review_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "body" text NOT NULL,
  "author_type" text NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" text,
  "created_by_run_id" uuid,
  "issue_comment_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_key" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "anchor_state" text DEFAULT 'active' NOT NULL,
  "anchor_confidence" text DEFAULT 'exact' NOT NULL,
  "original_revision_id" uuid,
  "original_revision_number" integer NOT NULL,
  "current_revision_id" uuid,
  "current_revision_number" integer NOT NULL,
  "selected_text" text NOT NULL,
  "proposed_text" text,
  "insertion_position" text,
  "prefix_text" text DEFAULT '' NOT NULL,
  "suffix_text" text DEFAULT '' NOT NULL,
  "normalized_start" integer NOT NULL,
  "normalized_end" integer NOT NULL,
  "markdown_start" integer NOT NULL,
  "markdown_end" integer NOT NULL,
  "anchor_selector" jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "accepted_by_agent_id" uuid,
  "accepted_by_user_id" text,
  "accepted_at" timestamp with time zone,
  "accepted_revision_id" uuid,
  "rejected_by_agent_id" uuid,
  "rejected_by_user_id" text,
  "rejected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_suggestion_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "suggestion_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "body" text NOT NULL,
  "author_type" text NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" text,
  "created_by_run_id" uuid,
  "issue_comment_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_suggestion_anchor_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "suggestion_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "from_revision_id" uuid,
  "from_revision_number" integer,
  "to_revision_id" uuid,
  "to_revision_number" integer NOT NULL,
  "previous_anchor" jsonb NOT NULL,
  "next_anchor" jsonb,
  "anchor_state" text NOT NULL,
  "anchor_confidence" text NOT NULL,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_threads" ADD CONSTRAINT "document_review_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_threads" ADD CONSTRAINT "document_review_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_threads" ADD CONSTRAINT "document_review_threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_threads" ADD CONSTRAINT "document_review_threads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_threads" ADD CONSTRAINT "document_review_threads_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_thread_id_document_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_review_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_review_comments" ADD CONSTRAINT "document_review_comments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_original_revision_id_document_revisions_id_fk" FOREIGN KEY ("original_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_current_revision_id_document_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_accepted_by_agent_id_agents_id_fk" FOREIGN KEY ("accepted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_accepted_revision_id_document_revisions_id_fk" FOREIGN KEY ("accepted_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_rejected_by_agent_id_agents_id_fk" FOREIGN KEY ("rejected_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_suggestion_id_document_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."document_suggestions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_comments" ADD CONSTRAINT "document_suggestion_comments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_anchor_snapshots" ADD CONSTRAINT "document_suggestion_anchor_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_anchor_snapshots" ADD CONSTRAINT "document_suggestion_anchor_snapshots_suggestion_id_document_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."document_suggestions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_anchor_snapshots" ADD CONSTRAINT "document_suggestion_anchor_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_anchor_snapshots" ADD CONSTRAINT "document_suggestion_anchor_snapshots_from_revision_id_document_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_suggestion_anchor_snapshots" ADD CONSTRAINT "document_suggestion_anchor_snapshots_to_revision_id_document_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_threads_company_document_status_idx" ON "document_review_threads" USING btree ("company_id","document_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_threads_company_issue_status_idx" ON "document_review_threads" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_comments_company_thread_created_at_idx" ON "document_review_comments" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_comments_company_issue_created_at_idx" ON "document_review_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_comments_issue_comment_idx" ON "document_review_comments" USING btree ("issue_comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_comments_body_search_idx" ON "document_review_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestions_company_document_status_idx" ON "document_suggestions" USING btree ("company_id","document_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestions_company_issue_status_idx" ON "document_suggestions" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestions_company_current_revision_pending_idx" ON "document_suggestions" USING btree ("company_id","document_id","current_revision_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestions_company_anchor_state_idx" ON "document_suggestions" USING btree ("company_id","anchor_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_comments_company_suggestion_created_at_idx" ON "document_suggestion_comments" USING btree ("company_id","suggestion_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_comments_company_issue_created_at_idx" ON "document_suggestion_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_comments_issue_comment_idx" ON "document_suggestion_comments" USING btree ("issue_comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_comments_body_search_idx" ON "document_suggestion_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_anchor_snapshots_company_suggestion_created_at_idx" ON "document_suggestion_anchor_snapshots" USING btree ("company_id","suggestion_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_suggestion_anchor_snapshots_company_document_revision_idx" ON "document_suggestion_anchor_snapshots" USING btree ("company_id","document_id","to_revision_number");
