CREATE TABLE "agent_idle_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"empty_heartbeat_streak" integer DEFAULT 0 NOT NULL,
	"last_meaningful_action_at" timestamp with time zone,
	"quiesced_at" timestamp with time zone,
	"next_watchdog_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_role_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"harness" text NOT NULL,
	"subscription" text NOT NULL,
	"provider" text NOT NULL,
	"quality_rank" real DEFAULT 1 NOT NULL,
	"is_saturated" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_role_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"mounted_paths" text[] DEFAULT '{}' NOT NULL,
	"read_only_paths" text[] DEFAULT '{}' NOT NULL,
	"candidate_models" text[] DEFAULT '{}' NOT NULL,
	"default_skills" text[] DEFAULT '{}' NOT NULL,
	"prompt_template_id" uuid,
	"model_family" text NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_role_definitions_role_unique" UNIQUE("role")
);
--> statement-breakpoint
CREATE TABLE "app_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_name" text NOT NULL,
	"image_sha" text NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"includes_migration" boolean DEFAULT false NOT NULL,
	"migration_summary" text,
	"verified_stable" boolean DEFAULT false NOT NULL,
	"verified_stable_at" timestamp with time zone,
	"last_rollback_at" timestamp with time zone,
	"dokploy_deploy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_probe_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"app_name" text NOT NULL,
	"probe_url" text NOT NULL,
	"expected_status" integer DEFAULT 200 NOT NULL,
	"body_regex" text,
	"body_excludes_regex" text,
	"smoke_endpoints" text[],
	"min_uptime_seconds" integer DEFAULT 30 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_probed_at" timestamp with time zone,
	"last_probe_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_kind_proof_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_kind" text NOT NULL,
	"requires_ci_proof" boolean DEFAULT true NOT NULL,
	"requires_live_url_proof" boolean DEFAULT false NOT NULL,
	"requires_review_approval" boolean DEFAULT false NOT NULL,
	"requires_doc_proof" boolean DEFAULT false NOT NULL,
	"proof_type_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_kind_proof_specs_issue_kind_unique" UNIQUE("issue_kind")
);
--> statement-breakpoint
CREATE TABLE "pr_ci_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"workflow_run_id" text,
	"check_run_id" text,
	"check_run_name" text,
	"conclusion" text,
	"status" text,
	"url" text,
	"review_approved_at" timestamp with time zone,
	"review_approved_by" text,
	"review_state" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_review_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"builder_agent_id" uuid,
	"breaker_agent_id" uuid,
	"builder_position" text,
	"breaker_position" text,
	"builder_family" text,
	"breaker_family" text,
	"jury_invoked" boolean DEFAULT false NOT NULL,
	"jury_triggered_at" timestamp with time zone,
	"jury_verdict" text,
	"jury_deliberated_at" timestamp with time zone,
	"review_complete" boolean DEFAULT false NOT NULL,
	"review_complete_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_family_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_review_state_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"reviewer_agent_id" uuid,
	"reviewer_family" text NOT NULL,
	"review_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"secret_name" text NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_agent_id" uuid,
	"actor_role" text,
	"access_granted" boolean DEFAULT false NOT NULL,
	"denial_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription" text NOT NULL,
	"provider" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"used_messages" integer DEFAULT 0 NOT NULL,
	"used_tokens" bigint DEFAULT 0 NOT NULL,
	"capacity_messages" integer NOT NULL,
	"capacity_tokens" bigint NOT NULL,
	"utilization_cap" real DEFAULT 0.7 NOT NULL,
	"is_saturated" boolean DEFAULT false NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_reference_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_thread_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"continuation_policy" text DEFAULT 'wake_assignee' NOT NULL,
	"idempotency_key" text,
	"source_comment_id" uuid,
	"source_run_id" uuid,
	"title" text,
	"summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_database_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"namespace_mode" text DEFAULT 'schema' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"migration_key" text NOT NULL,
	"checksum" text NOT NULL,
	"plugin_version" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "allowed_agent_roles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "allowed_agent_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "proof_ci_url" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "proof_live_url" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "proof_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "proof_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "proof_doc_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_idle_state" ADD CONSTRAINT "agent_idle_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_probe_specs" ADD CONSTRAINT "app_probe_specs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_ci_status" ADD CONSTRAINT "pr_ci_status_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_states" ADD CONSTRAINT "pr_review_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_states" ADD CONSTRAINT "pr_review_states_builder_agent_id_agents_id_fk" FOREIGN KEY ("builder_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_states" ADD CONSTRAINT "pr_review_states_breaker_agent_id_agents_id_fk" FOREIGN KEY ("breaker_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_family_log" ADD CONSTRAINT "reviewer_family_log_pr_review_state_id_pr_review_states_id_fk" FOREIGN KEY ("pr_review_state_id") REFERENCES "public"."pr_review_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_family_log" ADD CONSTRAINT "reviewer_family_log_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_idle_state_agent_id_idx" ON "agent_idle_state" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_idle_state_state_idx" ON "agent_idle_state" USING btree ("state");--> statement-breakpoint
CREATE INDEX "agent_idle_state_next_watchdog_idx" ON "agent_idle_state" USING btree ("next_watchdog_at");--> statement-breakpoint
CREATE INDEX "agent_idle_state_agent_id_uq" ON "agent_idle_state" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_role_candidates_role_model_harness_unique" ON "agent_role_candidates" USING btree ("role","model","harness");--> statement-breakpoint
CREATE INDEX "agent_role_candidates_role_idx" ON "agent_role_candidates" USING btree ("role");--> statement-breakpoint
CREATE INDEX "agent_role_candidates_subscription_idx" ON "agent_role_candidates" USING btree ("subscription","is_saturated");--> statement-breakpoint
CREATE INDEX "agent_role_definitions_role_idx" ON "agent_role_definitions" USING btree ("role");--> statement-breakpoint
CREATE INDEX "agent_role_definitions_model_family_idx" ON "agent_role_definitions" USING btree ("model_family");--> statement-breakpoint
CREATE INDEX "agent_role_definitions_active_idx" ON "agent_role_definitions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "app_deployments_app_name_idx" ON "app_deployments" USING btree ("app_name");--> statement-breakpoint
CREATE INDEX "app_deployments_verified_stable_idx" ON "app_deployments" USING btree ("app_name","verified_stable");--> statement-breakpoint
CREATE INDEX "app_deployments_deployed_at_idx" ON "app_deployments" USING btree ("deployed_at");--> statement-breakpoint
CREATE INDEX "app_probe_specs_company_app_idx" ON "app_probe_specs" USING btree ("company_id","app_name");--> statement-breakpoint
CREATE INDEX "app_probe_specs_active_idx" ON "app_probe_specs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "issue_kind_proof_specs_kind_idx" ON "issue_kind_proof_specs" USING btree ("issue_kind");--> statement-breakpoint
CREATE INDEX "pr_ci_status_company_repo_pr_idx" ON "pr_ci_status" USING btree ("company_id","repository_full_name","pr_number");--> statement-breakpoint
CREATE INDEX "pr_ci_status_head_sha_idx" ON "pr_ci_status" USING btree ("head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_ci_status_workflow_run_id_idx" ON "pr_ci_status" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_ci_status_check_run_id_idx" ON "pr_ci_status" USING btree ("check_run_id");--> statement-breakpoint
CREATE INDEX "pr_review_states_company_repo_pr_idx" ON "pr_review_states" USING btree ("company_id","repository_full_name","pr_number");--> statement-breakpoint
CREATE INDEX "pr_review_states_head_sha_idx" ON "pr_review_states" USING btree ("head_sha");--> statement-breakpoint
CREATE INDEX "pr_review_states_active_idx" ON "pr_review_states" USING btree ("review_complete");--> statement-breakpoint
CREATE INDEX "pr_review_states_jury_idx" ON "pr_review_states" USING btree ("jury_invoked");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_states_repo_pr_sha_unique" ON "pr_review_states" USING btree ("repository_full_name","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "reviewer_family_log_state_round_idx" ON "reviewer_family_log" USING btree ("pr_review_state_id","round");--> statement-breakpoint
CREATE INDEX "secret_access_log_secret_id_idx" ON "secret_access_log" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "secret_access_log_company_id_idx" ON "secret_access_log" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "secret_access_log_created_at_idx" ON "secret_access_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "subscription_quotas_subscription_idx" ON "subscription_quotas" USING btree ("subscription");--> statement-breakpoint
CREATE INDEX "subscription_quotas_window_idx" ON "subscription_quotas" USING btree ("window_start","window_end");--> statement-breakpoint
CREATE INDEX "subscription_quotas_saturated_idx" ON "subscription_quotas" USING btree ("subscription","is_saturated");--> statement-breakpoint
CREATE INDEX "subscription_quotas_subscription_window_unique" ON "subscription_quotas" USING btree ("subscription","window_start");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_source_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_target_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","target_issue_id");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_issue_pair_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_reference_mentions_company_source_mention_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind","source_record_id") WHERE "issue_reference_mentions"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_reference_mentions_company_source_mention_null_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind") WHERE "issue_reference_mentions"."source_record_id" is null;--> statement-breakpoint
CREATE INDEX "issue_thread_interactions_issue_idx" ON "issue_thread_interactions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_thread_interactions_company_issue_created_at_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_thread_interactions_company_issue_status_idx" ON "issue_thread_interactions" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_thread_interactions_company_issue_idempotency_uq" ON "issue_thread_interactions" USING btree ("company_id","issue_id","idempotency_key") WHERE "issue_thread_interactions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "issue_thread_interactions_source_comment_idx" ON "issue_thread_interactions" USING btree ("source_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");--> statement-breakpoint
CREATE INDEX "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_migrations_plugin_key_idx" ON "plugin_migrations" USING btree ("plugin_id","migration_key");--> statement-breakpoint
CREATE INDEX "plugin_migrations_plugin_idx" ON "plugin_migrations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_migrations_status_idx" ON "plugin_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "company_secrets_allowed_roles_idx" ON "company_secrets" USING btree ("allowed_agent_roles");--> statement-breakpoint
CREATE INDEX "company_secrets_allowed_agent_ids_idx" ON "company_secrets" USING btree ("allowed_agent_ids");