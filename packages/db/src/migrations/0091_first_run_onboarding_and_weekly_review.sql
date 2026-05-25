CREATE TABLE "weekly_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"latest_version_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"generated_at" timestamp with time zone,
	"generated_by_user_id" text,
	"source_window_start" timestamp with time zone NOT NULL,
	"source_window_end" timestamp with time zone NOT NULL,
	"summary_json" jsonb,
	"validation_json" jsonb,
	"narration_status" text DEFAULT 'not_requested' NOT NULL,
	"narration_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stable_id" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"workstream" text,
	"evidence_ids_json" jsonb,
	"recommended_action_json" jsonb,
	"recommendation_text" text,
	"reason_code" text,
	"source_entity_type" text,
	"source_entity_id" text,
	"confidence" text,
	"detected_at" timestamp with time zone,
	"validation_status" text DEFAULT 'unknown' NOT NULL,
	"rules_triggered_json" jsonb,
	"actor_id" text,
	"ui_cta_json" jsonb,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"finding_id" uuid,
	"company_id" uuid NOT NULL,
	"citation_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text,
	"label" text NOT NULL,
	"excerpt" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"finding_id" uuid,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"proposed_action_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"finding_id" uuid,
	"recommendation_id" uuid,
	"company_id" uuid NOT NULL,
	"action_kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" text,
	"target_entity_type" text,
	"target_entity_id" text,
	"request_json" jsonb,
	"result_json" jsonb,
	"activity_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid,
	"version_id" uuid,
	"company_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"actor_user_id" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"source_window_start" timestamp with time zone,
	"source_window_end" timestamp with time zone,
	"input_counts_json" jsonb,
	"finding_counts_json" jsonb,
	"citation_validation_json" jsonb,
	"adapter_readiness_summary_json" jsonb,
	"model_assurance_summary_json" jsonb,
	"error_code" text,
	"failure_reason" text,
	"debug_metadata_json" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapter_readiness_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"basic_ready" boolean DEFAULT false NOT NULL,
	"operational_ready" boolean DEFAULT false NOT NULL,
	"fixture_ready" boolean DEFAULT false NOT NULL,
	"reason_codes_json" jsonb,
	"cli_version" text,
	"auth_mode" text,
	"model" text,
	"resolved_model" text,
	"model_source" text DEFAULT 'unknown' NOT NULL,
	"model_profile" text,
	"model_available" boolean DEFAULT false NOT NULL,
	"model_runnable" boolean DEFAULT false NOT NULL,
	"model_policy_status" text DEFAULT 'unknown' NOT NULL,
	"role_fit" text DEFAULT 'unknown' NOT NULL,
	"role_fit_reason" text,
	"model_reason_codes_json" jsonb,
	"model_capabilities_json" jsonb,
	"workspace_status" text,
	"quota_windows_json" jsonb,
	"hello_run_status" text,
	"hello_run_metadata_json" jsonb,
	"heartbeat_run_id" uuid,
	"fallback_recommendation_json" jsonb,
	"strict_mode" boolean DEFAULT false NOT NULL,
	"checked_by_user_id" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_versions" ADD CONSTRAINT "weekly_review_versions_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_versions" ADD CONSTRAINT "weekly_review_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_versions" ADD CONSTRAINT "weekly_review_versions_generated_by_user_id_user_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_findings" ADD CONSTRAINT "weekly_review_findings_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_findings" ADD CONSTRAINT "weekly_review_findings_version_id_weekly_review_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."weekly_review_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_findings" ADD CONSTRAINT "weekly_review_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_citations" ADD CONSTRAINT "weekly_review_citations_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_citations" ADD CONSTRAINT "weekly_review_citations_version_id_weekly_review_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."weekly_review_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_citations" ADD CONSTRAINT "weekly_review_citations_finding_id_weekly_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."weekly_review_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_citations" ADD CONSTRAINT "weekly_review_citations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_recommendations" ADD CONSTRAINT "weekly_review_recommendations_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_recommendations" ADD CONSTRAINT "weekly_review_recommendations_version_id_weekly_review_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."weekly_review_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_recommendations" ADD CONSTRAINT "weekly_review_recommendations_finding_id_weekly_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."weekly_review_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_recommendations" ADD CONSTRAINT "weekly_review_recommendations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_version_id_weekly_review_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."weekly_review_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_finding_id_weekly_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."weekly_review_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_recommendation_id_weekly_review_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."weekly_review_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_actions" ADD CONSTRAINT "weekly_review_actions_activity_log_id_activity_log_id_fk" FOREIGN KEY ("activity_log_id") REFERENCES "public"."activity_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_events" ADD CONSTRAINT "weekly_review_events_review_id_weekly_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."weekly_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_events" ADD CONSTRAINT "weekly_review_events_version_id_weekly_review_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."weekly_review_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_events" ADD CONSTRAINT "weekly_review_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_review_events" ADD CONSTRAINT "weekly_review_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_readiness_probes" ADD CONSTRAINT "adapter_readiness_probes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_readiness_probes" ADD CONSTRAINT "adapter_readiness_probes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_readiness_probes" ADD CONSTRAINT "adapter_readiness_probes_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_readiness_probes" ADD CONSTRAINT "adapter_readiness_probes_checked_by_user_id_user_id_fk" FOREIGN KEY ("checked_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_reviews_company_period_idx" ON "weekly_reviews" USING btree ("company_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "weekly_reviews_company_status_idx" ON "weekly_reviews" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "weekly_review_versions_review_version_idx" ON "weekly_review_versions" USING btree ("review_id","version_number");--> statement-breakpoint
CREATE INDEX "weekly_review_versions_company_status_idx" ON "weekly_review_versions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "weekly_review_findings_version_idx" ON "weekly_review_findings" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "weekly_review_findings_company_category_idx" ON "weekly_review_findings" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "weekly_review_findings_version_stable_idx" ON "weekly_review_findings" USING btree ("version_id","stable_id");--> statement-breakpoint
CREATE INDEX "weekly_review_citations_version_idx" ON "weekly_review_citations" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "weekly_review_citations_entity_idx" ON "weekly_review_citations" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "weekly_review_recommendations_version_idx" ON "weekly_review_recommendations" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "weekly_review_recommendations_finding_idx" ON "weekly_review_recommendations" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "weekly_review_actions_version_idx" ON "weekly_review_actions" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "weekly_review_actions_company_status_idx" ON "weekly_review_actions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "weekly_review_events_company_created_idx" ON "weekly_review_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "weekly_review_events_expires_idx" ON "weekly_review_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "adapter_readiness_probes_company_agent_created_idx" ON "adapter_readiness_probes" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "adapter_readiness_probes_adapter_created_idx" ON "adapter_readiness_probes" USING btree ("adapter_type","created_at");--> statement-breakpoint
CREATE INDEX "adapter_readiness_probes_expires_idx" ON "adapter_readiness_probes" USING btree ("expires_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_onboarding_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"starter_issue_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'first_run' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_setups_company_id_companies_id_fk') THEN
		ALTER TABLE "company_onboarding_setups" ADD CONSTRAINT "company_onboarding_setups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_setups_starter_issue_id_issues_id_fk') THEN
		ALTER TABLE "company_onboarding_setups" ADD CONSTRAINT "company_onboarding_setups_starter_issue_id_issues_id_fk" FOREIGN KEY ("starter_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_onboarding_setups_company_uq" ON "company_onboarding_setups" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_onboarding_setups_company_status_idx" ON "company_onboarding_setups" USING btree ("company_id","status");
