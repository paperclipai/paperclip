CREATE TABLE IF NOT EXISTS "rt2_quality_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "deliverable_id" uuid,
  "task_issue_id" uuid NOT NULL,
  "evaluator" text NOT NULL,
  "eval_type" text NOT NULL,
  "score" integer NOT NULL,
  "direction" text NOT NULL,
  "category" text NOT NULL,
  "rationale" text,
  "is_active" integer DEFAULT 1 NOT NULL,
  "manager_decision" text,
  "manager_id" text,
  "manager_feedback" text,
  "is_finalized" integer DEFAULT 0 NOT NULL,
  "base_price" integer,
  "auto_approval_band_low" integer,
  "auto_approval_band_high" integer,
  "evaluation_mode" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_quality_scores" ADD CONSTRAINT "rt2_quality_scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_quality_scores" ADD CONSTRAINT "rt2_quality_scores_deliverable_id_issues_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_quality_scores" ADD CONSTRAINT "rt2_quality_scores_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_company_idx" ON "rt2_quality_scores" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_deliverable_idx" ON "rt2_quality_scores" USING btree ("deliverable_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_task_idx" ON "rt2_quality_scores" USING btree ("task_issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_evaluator_idx" ON "rt2_quality_scores" USING btree ("evaluator");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_active_idx" ON "rt2_quality_scores" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_quality_scores_pending_idx" ON "rt2_quality_scores" USING btree ("is_finalized");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_base_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "deliverable_type" text NOT NULL,
  "base_price" integer NOT NULL,
  "auto_approve_threshold" real DEFAULT 0.1 NOT NULL,
  "is_active" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_base_prices" ADD CONSTRAINT "rt2_base_prices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_base_prices_company_type_idx" ON "rt2_base_prices" USING btree ("company_id","deliverable_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt2_base_prices_company_active_idx" ON "rt2_base_prices" USING btree ("company_id","is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_search_index" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "document_type" text NOT NULL,
  "last_indexed_id" uuid,
  "indexed_count" integer DEFAULT 0 NOT NULL,
  "indexed_pages" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'idle' NOT NULL,
  "error_message" text,
  "indexing_started_at" timestamp with time zone,
  "indexing_completed_at" timestamp with time zone,
  "features_enabled" text DEFAULT 'keyword' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_search_index" ADD CONSTRAINT "rt2_search_index_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_index_company_idx" ON "rt2_search_index" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_index_status_idx" ON "rt2_search_index" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_search_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "query" text NOT NULL,
  "results_count" integer DEFAULT 0 NOT NULL,
  "search_time_ms" integer DEFAULT 0 NOT NULL,
  "search_type" text DEFAULT 'keyword' NOT NULL,
  "actor_id" text,
  "actor_type" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_search_log" ADD CONSTRAINT "rt2_search_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_log_company_query_idx" ON "rt2_search_log" USING btree ("company_id","query");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_log_created_idx" ON "rt2_search_log" USING btree ("created_at");
