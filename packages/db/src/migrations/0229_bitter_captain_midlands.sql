CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"duration_ms" integer,
	"progress" integer DEFAULT 0 NOT NULL,
	"progress_message" text,
	"created_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_status_check" CHECK ("background_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "background_jobs_progress_check" CHECK ("background_jobs"."progress" >= 0 AND "background_jobs"."progress" <= 100),
	CONSTRAINT "background_jobs_duration_check" CHECK ("background_jobs"."duration_ms" IS NULL OR "background_jobs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"stripe_customer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"billing_period" text DEFAULT 'monthly' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"metadata_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_subscriptions_company_unique_idx" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"invoice_number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"amount_remaining_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"invoice_pdf_url" text,
	"hosted_invoice_url" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_monthly_cents" integer DEFAULT 0 NOT NULL,
	"price_yearly_cents" integer DEFAULT 0 NOT NULL,
	"stripe_price_monthly_id" text,
	"stripe_price_yearly_id" text,
	"stripe_product_id" text,
	"included_seats" integer DEFAULT 0 NOT NULL,
	"extra_seat_price_cents" integer DEFAULT 0 NOT NULL,
	"included_agent_runs" integer DEFAULT 0 NOT NULL,
	"extra_agent_run_price_cents" integer DEFAULT 0 NOT NULL,
	"included_storage_gb" integer DEFAULT 0 NOT NULL,
	"extra_storage_gb_price_cents" integer DEFAULT 0 NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"usage" integer DEFAULT 0 NOT NULL,
	"included" integer DEFAULT 0 NOT NULL,
	"overage" integer DEFAULT 0 NOT NULL,
	"overage_cents" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"stripe_usage_record_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_document_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"reviewer_agent_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"change_description" text,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"author_agent_id" uuid,
	"source_issue_id" uuid,
	"memory_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_source_backlinks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_type" text DEFAULT 'referenced_in_body' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_binding_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider_type" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_extraction_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"operation_id" uuid,
	"provider_job_id" text NOT NULL,
	"hook_kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid,
	"provider_key" text,
	"operation_type" text NOT NULL,
	"scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_agent_id" uuid,
	"heartbeat_run_id" uuid,
	"success" boolean NOT NULL,
	"error_message" text,
	"latency_ms" integer NOT NULL,
	"usage_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"text" text NOT NULL,
	"summary" text,
	"embedding" vector(1536),
	"scope_company_id" uuid,
	"scope_agent_id" uuid,
	"scope_project_id" uuid,
	"scope_issue_id" uuid,
	"scope_run_id" uuid,
	"scope_subject_id" text,
	"scope_session_key" text,
	"scope_namespace" text,
	"source_kind" text NOT NULL,
	"source_issue_id" uuid,
	"source_comment_id" uuid,
	"source_document_key" text,
	"source_run_id" uuid,
	"source_activity_id" uuid,
	"source_external_ref" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"importance" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"digest_frequency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_url" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"push_sent_at" timestamp with time zone,
	"email_delivery_status" text,
	"email_delivery_error" text,
	"push_delivery_status" text,
	"push_delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_review_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"milestone_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_agent_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_comment" text,
	"superseded_by_gate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_jobs" DROP CONSTRAINT IF EXISTS "background_jobs_company_id_companies_id_fk";
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_subscriptions" DROP CONSTRAINT IF EXISTS "company_subscriptions_company_id_companies_id_fk";
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_subscriptions" DROP CONSTRAINT IF EXISTS "company_subscriptions_tier_id_subscription_tiers_id_fk";
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_tier_id_subscription_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."subscription_tiers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_subscriptions" DROP CONSTRAINT IF EXISTS "company_subscriptions_stripe_customer_id_stripe_customers_id_fk";
ALTER TABLE "company_subscriptions" ADD CONSTRAINT "company_subscriptions_stripe_customer_id_stripe_customers_id_fk" FOREIGN KEY ("stripe_customer_id") REFERENCES "public"."stripe_customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stripe_customers" DROP CONSTRAINT IF EXISTS "stripe_customers_company_id_companies_id_fk";
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_invoices" DROP CONSTRAINT IF EXISTS "subscription_invoices_company_id_companies_id_fk";
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_invoices" DROP CONSTRAINT IF EXISTS "subscription_invoices_subscription_id_company_subscriptions_id_fk";
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscription_id_company_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."company_subscriptions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_usage" DROP CONSTRAINT IF EXISTS "subscription_usage_company_id_companies_id_fk";
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_usage" DROP CONSTRAINT IF EXISTS "subscription_usage_subscription_id_company_subscriptions_id_fk";
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_company_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."company_subscriptions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_document_reviews" DROP CONSTRAINT IF EXISTS "knowledge_document_reviews_document_id_knowledge_documents_id_fk";
ALTER TABLE "knowledge_document_reviews" ADD CONSTRAINT "knowledge_document_reviews_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_document_reviews" DROP CONSTRAINT IF EXISTS "knowledge_document_reviews_revision_id_knowledge_document_revisions_id_fk";
ALTER TABLE "knowledge_document_reviews" ADD CONSTRAINT "knowledge_document_reviews_revision_id_knowledge_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_document_reviews" DROP CONSTRAINT IF EXISTS "knowledge_document_reviews_reviewer_agent_id_agents_id_fk";
ALTER TABLE "knowledge_document_reviews" ADD CONSTRAINT "knowledge_document_reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_document_revisions" DROP CONSTRAINT IF EXISTS "knowledge_document_revisions_document_id_knowledge_documents_id_fk";
ALTER TABLE "knowledge_document_revisions" ADD CONSTRAINT "knowledge_document_revisions_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_document_revisions" DROP CONSTRAINT IF EXISTS "knowledge_document_revisions_author_agent_id_agents_id_fk";
ALTER TABLE "knowledge_document_revisions" ADD CONSTRAINT "knowledge_document_revisions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" DROP CONSTRAINT IF EXISTS "knowledge_documents_company_id_companies_id_fk";
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" DROP CONSTRAINT IF EXISTS "knowledge_documents_author_agent_id_agents_id_fk";
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" DROP CONSTRAINT IF EXISTS "knowledge_documents_source_issue_id_issues_id_fk";
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_source_backlinks" DROP CONSTRAINT IF EXISTS "knowledge_source_backlinks_document_id_knowledge_documents_id_fk";
ALTER TABLE "knowledge_source_backlinks" ADD CONSTRAINT "knowledge_source_backlinks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_source_backlinks" DROP CONSTRAINT IF EXISTS "knowledge_source_backlinks_source_issue_id_issues_id_fk";
ALTER TABLE "knowledge_source_backlinks" ADD CONSTRAINT "knowledge_source_backlinks_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" DROP CONSTRAINT IF EXISTS "memory_binding_targets_company_id_companies_id_fk";
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_binding_targets" DROP CONSTRAINT IF EXISTS "memory_binding_targets_binding_id_memory_bindings_id_fk";
ALTER TABLE "memory_binding_targets" ADD CONSTRAINT "memory_binding_targets_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_bindings" DROP CONSTRAINT IF EXISTS "memory_bindings_company_id_companies_id_fk";
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" DROP CONSTRAINT IF EXISTS "memory_extraction_jobs_company_id_companies_id_fk";
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" DROP CONSTRAINT IF EXISTS "memory_extraction_jobs_binding_id_memory_bindings_id_fk";
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs" DROP CONSTRAINT IF EXISTS "memory_extraction_jobs_operation_id_memory_operations_id_fk";
ALTER TABLE "memory_extraction_jobs" ADD CONSTRAINT "memory_extraction_jobs_operation_id_memory_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."memory_operations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" DROP CONSTRAINT IF EXISTS "memory_operations_company_id_companies_id_fk";
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_operations" DROP CONSTRAINT IF EXISTS "memory_operations_binding_id_memory_bindings_id_fk";
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_records" DROP CONSTRAINT IF EXISTS "memory_records_company_id_companies_id_fk";
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_records" DROP CONSTRAINT IF EXISTS "memory_records_binding_id_memory_bindings_id_fk";
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_company_id_companies_id_fk";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_user_id_user_id_fk";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_company_id_companies_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_user_id_user_id_fk";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_company_id_companies_id_fk";
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_user_id_user_id_fk";
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_company_id_companies_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_document_id_documents_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_revision_id_document_revisions_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_revision_id_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_assigned_agent_id_agents_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_created_by_agent_id_agents_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_review_gates" DROP CONSTRAINT IF EXISTS "plan_review_gates_resolved_by_agent_id_agents_id_fk";
ALTER TABLE "plan_review_gates" ADD CONSTRAINT "plan_review_gates_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_company_status_idx" ON "background_jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_company_created_idx" ON "background_jobs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_job_type_idx" ON "background_jobs" USING btree ("job_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_queued_status_idx" ON "background_jobs" USING btree ("status") WHERE "background_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_subscriptions_company_idx" ON "company_subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_stripe_subscription_idx" ON "company_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_company_idx" ON "stripe_customers" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_stripe_customer_idx" ON "stripe_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_events_event_id_idx" ON "stripe_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_invoices_company_idx" ON "subscription_invoices" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoices_stripe_invoice_idx" ON "subscription_invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_invoices_subscription_idx" ON "subscription_invoices" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_tiers_name_idx" ON "subscription_tiers" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_usage_company_period_idx" ON "subscription_usage" USING btree ("company_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_usage_sub_metric_period_idx" ON "subscription_usage" USING btree ("subscription_id","metric","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_document_reviews_document_idx" ON "knowledge_document_reviews" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_document_reviews_revision_idx" ON "knowledge_document_reviews" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_document_revisions_document_version_idx" ON "knowledge_document_revisions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_document_revisions_doc_ver_unique_idx" ON "knowledge_document_revisions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_company_status_idx" ON "knowledge_documents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_company_created_idx" ON "knowledge_documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_company_updated_idx" ON "knowledge_documents" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_memory_record_unique_idx" ON "knowledge_documents" USING btree ("memory_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_source_backlinks_doc_issue_unique_idx" ON "knowledge_source_backlinks" USING btree ("document_id","source_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_source_backlinks_issue_idx" ON "knowledge_source_backlinks" USING btree ("source_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_binding_targets_company_target_idx" ON "memory_binding_targets" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_binding_targets_binding_idx" ON "memory_binding_targets" USING btree ("binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_bindings_company_key_idx" ON "memory_bindings" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_bindings_company_provider_idx" ON "memory_bindings" USING btree ("company_id","provider_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_jobs_company_binding_status_idx" ON "memory_extraction_jobs" USING btree ("company_id","binding_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_jobs_provider_job_idx" ON "memory_extraction_jobs" USING btree ("provider_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_operations_company_binding_op_idx" ON "memory_operations" USING btree ("company_id","binding_id","operation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_operations_company_created_idx" ON "memory_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_company_scope_idx" ON "memory_records" USING btree ("company_id","scope_agent_id","record_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_source_idx" ON "memory_records" USING btree ("company_id","source_kind","source_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_company_binding_idx" ON "memory_records" USING btree ("company_id","binding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_created_at_idx" ON "memory_records" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_records_embedding_hnsw_idx" ON "memory_records" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_prefs_company_user_type_channel_uq" ON "notification_preferences" USING btree ("company_id","user_id","notification_type","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_prefs_company_user_idx" ON "notification_preferences" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_company_user_idx" ON "notifications" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_company_user_created_idx" ON "notifications" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_execution_error_run_user_uq" ON "notifications" USING btree ("company_id","user_id",(metadata_json->>'runId')) WHERE "notifications"."notification_type" = 'execution_error' AND metadata_json ? 'runId';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_company_user_idx" ON "push_subscriptions" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_review_gates_document_revision_idx" ON "plan_review_gates" USING btree ("company_id","document_id","revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_review_gates_pending_idx" ON "plan_review_gates" USING btree ("company_id","document_id","revision_id") WHERE "plan_review_gates"."status" = 'pending';