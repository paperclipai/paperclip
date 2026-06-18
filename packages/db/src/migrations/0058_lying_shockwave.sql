CREATE TABLE "agent_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
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
CREATE TABLE "document_annotation_anchor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
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
);
--> statement-breakpoint
CREATE TABLE "document_annotation_comments" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_annotation_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"anchor_state" text DEFAULT 'active' NOT NULL,
	"original_revision_id" uuid,
	"original_revision_number" integer NOT NULL,
	"current_revision_id" uuid,
	"current_revision_number" integer NOT NULL,
	"selected_text" text NOT NULL,
	"prefix_text" text DEFAULT '' NOT NULL,
	"suffix_text" text DEFAULT '' NOT NULL,
	"normalized_start" integer NOT NULL,
	"normalized_end" integer NOT NULL,
	"markdown_start" integer NOT NULL,
	"markdown_end" integer NOT NULL,
	"anchor_confidence" text DEFAULT 'exact' NOT NULL,
	"anchor_selector" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_policy" text DEFAULT 'ephemeral' NOT NULL,
	"provider" text,
	"provider_lease_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"failure_reason" text,
	"cleanup_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"driver" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeat_run_watchdog_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"evaluation_issue_id" uuid,
	"decision" text NOT NULL,
	"snoozed_until" timestamp with time zone,
	"reason" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"est_ctx" integer NOT NULL,
	"est_diff" integer NOT NULL,
	"chosen_model" text NOT NULL,
	"rule_id" text NOT NULL,
	"fallback_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "issue_tree_hold_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_issue_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"issue_identifier" text,
	"issue_title" text NOT NULL,
	"issue_status" text NOT NULL,
	"assignee_agent_id" uuid,
	"assignee_user_id" text,
	"active_run_id" uuid,
	"active_run_status" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_tree_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"release_policy" jsonb,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_actor_type" text,
	"released_by_agent_id" uuid,
	"released_by_user_id" text,
	"released_by_run_id" uuid,
	"release_reason" text,
	"release_metadata" jsonb,
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
CREATE TABLE "plugin_managed_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
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
ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_upstream_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_from_revision_id_document_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_to_revision_id_document_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_original_revision_id_document_revisions_id_fk" FOREIGN KEY ("original_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_current_revision_id_document_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_evaluation_issue_id_issues_id_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_routing_decisions" ADD CONSTRAINT "issue_routing_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_recovery_issue_id_issues_id_fk" FOREIGN KEY ("recovery_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_previous_owner_agent_id_agents_id_fk" FOREIGN KEY ("previous_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_return_owner_agent_id_agents_id_fk" FOREIGN KEY ("return_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_hold_id_issue_tree_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."issue_tree_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_agent_id_agents_id_fk" FOREIGN KEY ("released_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("released_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memberships_company_user_idx" ON "agent_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_memberships_agent_idx" ON "agent_memberships" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memberships_company_user_agent_uq" ON "agent_memberships" USING btree ("company_id","user_id","agent_id");--> statement-breakpoint
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
CREATE INDEX "document_annotation_anchor_snapshots_company_thread_created_at_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_anchor_snapshots_company_document_revision_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","document_id","to_revision_number");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_thread_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_issue_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_document_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_body_search_idx" ON "document_annotation_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_document_status_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_issue_status_idx" ON "document_annotation_threads" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_current_revision_open_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","current_revision_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_anchor_state_idx" ON "document_annotation_threads" USING btree ("company_id","anchor_state");--> statement-breakpoint
CREATE INDEX "environment_leases_company_environment_status_idx" ON "environment_leases" USING btree ("company_id","environment_id","status");--> statement-breakpoint
CREATE INDEX "environment_leases_company_execution_workspace_idx" ON "environment_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_issue_idx" ON "environment_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "environment_leases_heartbeat_run_idx" ON "environment_leases" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_last_used_idx" ON "environment_leases" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "environment_leases_provider_lease_idx" ON "environment_leases" USING btree ("provider_lease_id");--> statement-breakpoint
CREATE INDEX "environments_company_status_idx" ON "environments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "environments"."driver" = 'local';--> statement-breakpoint
CREATE INDEX "environments_company_name_idx" ON "environments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "heartbeat_run_watchdog_decisions_company_run_created_idx" ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_run_watchdog_decisions_company_run_snooze_idx" ON "heartbeat_run_watchdog_decisions" USING btree ("company_id","run_id","snoozed_until");--> statement-breakpoint
CREATE INDEX "issue_routing_decisions_issue_idx" ON "issue_routing_decisions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_source_status_idx" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_owner_status_idx" ON "issue_recovery_actions" USING btree ("company_id","owner_agent_id","status");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_company_recovery_issue_idx" ON "issue_recovery_actions" USING btree ("company_id","recovery_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recovery_actions_active_source_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recovery_actions_active_fingerprint_uq" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id","cause","fingerprint") WHERE "issue_recovery_actions"."status" in ('active', 'escalated');--> statement-breakpoint
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
CREATE UNIQUE INDEX "issue_tree_hold_members_hold_issue_uq" ON "issue_tree_hold_members" USING btree ("hold_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_tree_hold_members_company_issue_idx" ON "issue_tree_hold_members" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_tree_hold_members_hold_depth_idx" ON "issue_tree_hold_members" USING btree ("hold_id","depth");--> statement-breakpoint
CREATE INDEX "issue_tree_holds_company_root_status_idx" ON "issue_tree_holds" USING btree ("company_id","root_issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_tree_holds_company_status_mode_idx" ON "issue_tree_holds" USING btree ("company_id","status","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");--> statement-breakpoint
CREATE INDEX "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_migrations_plugin_key_idx" ON "plugin_migrations" USING btree ("plugin_id","migration_key");--> statement-breakpoint
CREATE INDEX "plugin_migrations_plugin_idx" ON "plugin_migrations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_migrations_status_idx" ON "plugin_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_company_idx" ON "plugin_managed_resources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_plugin_idx" ON "plugin_managed_resources" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_resource_idx" ON "plugin_managed_resources" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_managed_resources_company_plugin_resource_uq" ON "plugin_managed_resources" USING btree ("company_id","plugin_id","resource_kind","resource_key");--> statement-breakpoint
CREATE INDEX "project_memberships_company_user_idx" ON "project_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_project_idx" ON "project_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_company_user_project_uq" ON "project_memberships" USING btree ("company_id","user_id","project_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_run_idx" ON "secret_access_events" USING btree ("heartbeat_run_id");