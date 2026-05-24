CREATE TABLE "agent_work_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"manager_agent_id" uuid,
	"last_issue_id" uuid,
	"idle_since_iso" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"manager_woke_at" timestamp with time zone,
	"manager_response_latency_ms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upstream_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"source_instance_fingerprint" text NOT NULL,
	"source_public_key" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"token_status" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"authorized_global_user_id" text,
	"access_token" text,
	"token_id" text,
	"token_expires_at" timestamp with time zone,
	"target_stack_id" text NOT NULL,
	"target_stack_slug" text,
	"target_stack_display_name" text,
	"target_company_id" text NOT NULL,
	"target_origin" text NOT NULL,
	"target_primary_host" text NOT NULL,
	"target_product" text NOT NULL,
	"target_schema_major" integer NOT NULL,
	"target_max_chunk_bytes" integer NOT NULL,
	"pending_state" text,
	"pending_code_verifier" text,
	"pending_redirect_uri" text,
	"pending_token_url" text,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upstream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_run_id" text,
	"status" text NOT NULL,
	"active_step" text NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"retry_of_run_id" uuid,
	"summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"target_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "company_secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_secret_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text,
	"health_checked_at" timestamp with time zone,
	"health_message" text,
	"health_details" jsonb,
	"disabled_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"recovery_issue_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_type" text DEFAULT 'agent' NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"previous_owner_agent_id" uuid,
	"return_owner_agent_id" uuid,
	"cause" text NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action" text NOT NULL,
	"wake_policy" jsonb,
	"monitor_policy" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer,
	"timeout_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"outcome" text,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"version" integer,
	"provider" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"consumer_type" text NOT NULL,
	"consumer_id" text NOT NULL,
	"config_path" text,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_cap_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"month" date NOT NULL,
	"offset_tokens" bigint NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"authorized_by_user_id" text,
	"authorized_by_agent_id" uuid,
	"recover_issue_id" uuid,
	CONSTRAINT "token_cap_resets_exactly_one_authorized_by" CHECK (("token_cap_resets"."authorized_by_user_id" IS NOT NULL)::int + ("token_cap_resets"."authorized_by_agent_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "token_cap_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"month" date NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lad_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lad_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"wall_clock_iso" text NOT NULL,
	"workers" jsonb,
	"scheduler" jsonb,
	"queue_depths" jsonb,
	"last_errors" jsonb,
	"ack_iso" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lad_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lad_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lad_records" (
	"lad_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'down' NOT NULL,
	"staleness_threshold_sec" integer DEFAULT 120 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lad_records_pk" PRIMARY KEY("lad_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "lad_scheduler_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lad_id" text NOT NULL,
	"ts_start" timestamp with time zone NOT NULL,
	"ts_end" timestamp with time zone NOT NULL,
	"metric_key" text NOT NULL,
	"metric_value" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_agent_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lad_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"ts_start" timestamp with time zone NOT NULL,
	"ts_end" timestamp with time zone NOT NULL,
	"metric_key" text NOT NULL,
	"metric_value" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_triage_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"suggested_department" text NOT NULL,
	"confidence" double precision NOT NULL,
	"rationale" text NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_triage_suggestions_suggested_department_check" CHECK ("shadow_triage_suggestions"."suggested_department" IN ('CTO','CMO','UX','CEO'))
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"endpoint" text NOT NULL,
	"subscription" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "monthly_token_cap_tokens" bigint;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "provider_version_ref" text;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "fingerprint_sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "rotation_job_id" text;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "managed_mode" text DEFAULT 'paperclip_managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "provider_config_id" uuid;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "last_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "last_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "locked_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "locked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "routine_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "env" jsonb;--> statement-breakpoint
ALTER TABLE "agent_work_requests" ADD CONSTRAINT "agent_work_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_work_requests" ADD CONSTRAINT "agent_work_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_work_requests" ADD CONSTRAINT "agent_work_requests_manager_agent_id_agents_id_fk" FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_upstream_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_recovery_issue_id_issues_id_fk" FOREIGN KEY ("recovery_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_previous_owner_agent_id_agents_id_fk" FOREIGN KEY ("previous_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_return_owner_agent_id_agents_id_fk" FOREIGN KEY ("return_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_resets" ADD CONSTRAINT "token_cap_resets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_resets" ADD CONSTRAINT "token_cap_resets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_resets" ADD CONSTRAINT "token_cap_resets_authorized_by_agent_id_agents_id_fk" FOREIGN KEY ("authorized_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_resets" ADD CONSTRAINT "token_cap_resets_recover_issue_id_issues_id_fk" FOREIGN KEY ("recover_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_warnings" ADD CONSTRAINT "token_cap_warnings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_cap_warnings" ADD CONSTRAINT "token_cap_warnings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lad_heartbeats" ADD CONSTRAINT "lad_heartbeats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lad_incidents" ADD CONSTRAINT "lad_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lad_incidents" ADD CONSTRAINT "lad_incidents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lad_records" ADD CONSTRAINT "lad_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lad_scheduler_metrics" ADD CONSTRAINT "lad_scheduler_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_metrics" ADD CONSTRAINT "local_agent_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_triage_suggestions" ADD CONSTRAINT "shadow_triage_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_triage_suggestions" ADD CONSTRAINT "shadow_triage_suggestions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_work_requests_company_agent_status_idx" ON "agent_work_requests" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_work_requests_agent_created_idx" ON "agent_work_requests" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_upstream_connections_company_idx" ON "cloud_upstream_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_company_created_idx" ON "cloud_upstream_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_connection_idx" ON "cloud_upstream_runs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_company_idx" ON "company_secret_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_secret_idx" ON "company_secret_bindings" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_target_idx" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_bindings_target_path_uq" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id","config_path");--> statement-breakpoint
CREATE INDEX "company_secret_provider_configs_company_idx" ON "company_secret_provider_configs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_secret_provider_configs_company_provider_idx" ON "company_secret_provider_configs" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_provider_configs_default_uq" ON "company_secret_provider_configs" USING btree ("company_id","provider") WHERE "company_secret_provider_configs"."is_default" = true;--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_source_status_idx" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_owner_status_idx" ON "issue_recovery_actions" USING btree ("company_id","owner_agent_id","status");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_recovery_issue_idx" ON "issue_recovery_actions" USING btree ("company_id","recovery_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recovery_actions_active_source_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recovery_actions_active_fingerprint_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","cause","fingerprint") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');--> statement-breakpoint
CREATE INDEX "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_run_idx" ON "secret_access_events" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "token_cap_resets_company_agent_month_idx" ON "token_cap_resets" USING btree ("company_id","agent_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "token_cap_warnings_agent_month_uniq" ON "token_cap_warnings" USING btree ("agent_id","month");--> statement-breakpoint
CREATE INDEX "lad_heartbeats_lad_created_idx" ON "lad_heartbeats" USING btree ("lad_id","company_id","created_at");--> statement-breakpoint
CREATE INDEX "lad_heartbeats_company_idx" ON "lad_heartbeats" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "lad_incidents_company_lad_idx" ON "lad_incidents" USING btree ("company_id","lad_id");--> statement-breakpoint
CREATE INDEX "lad_incidents_open_idx" ON "lad_incidents" USING btree ("company_id","lad_id","status");--> statement-breakpoint
CREATE INDEX "lad_records_company_idx" ON "lad_records" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "lad_scheduler_metrics_lad_ts_idx" ON "lad_scheduler_metrics" USING btree ("company_id","lad_id","ts_start");--> statement-breakpoint
CREATE INDEX "lad_scheduler_metrics_company_idx" ON "lad_scheduler_metrics" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "local_agent_metrics_agent_ts_idx" ON "local_agent_metrics" USING btree ("company_id","agent_id","ts_start");--> statement-breakpoint
CREATE INDEX "local_agent_metrics_lad_ts_idx" ON "local_agent_metrics" USING btree ("company_id","lad_id","ts_start");--> statement-breakpoint
CREATE INDEX "local_agent_metrics_company_idx" ON "local_agent_metrics" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_triage_suggestions_issue_uniq" ON "shadow_triage_suggestions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "shadow_triage_suggestions_company_created_idx" ON "shadow_triage_suggestions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_uq" ON "web_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "web_push_subscriptions_user_idx" ON "web_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_agent_id_agents_id_fk" FOREIGN KEY ("locked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_secret_versions_fingerprint_idx" ON "company_secret_versions" USING btree ("fingerprint_sha256");--> statement-breakpoint
CREATE INDEX "company_secrets_provider_config_idx" ON "company_secrets" USING btree ("provider_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");