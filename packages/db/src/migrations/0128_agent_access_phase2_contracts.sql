ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "application_key" text;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

UPDATE "tool_applications"
SET "application_key" = lower(regexp_replace("name", '[^a-zA-Z0-9._:-]+', '-', 'g'))
WHERE "application_key" IS NULL;--> statement-breakpoint

ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "connection_kind" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "transport_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint

UPDATE "tool_connections"
SET "transport_config" = coalesce(nullif("config", '{}'::jsonb), '{}'::jsonb)
WHERE "transport_config" = '{}'::jsonb
  AND "config" <> '{}'::jsonb;--> statement-breakpoint

ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "application_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "entry_kind" text DEFAULT 'tool' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "tool_name" text;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "output_schema" jsonb;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_read_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_write" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "is_destructive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "version" text;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "schema_hash" text;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" text;--> statement-breakpoint

UPDATE "tool_catalog_entries" AS e
SET
  "application_id" = c."application_id",
  "tool_name" = coalesce(e."tool_name", e."name"),
  "is_read_only" = CASE WHEN e."risk_level" = 'read' THEN true ELSE false END,
  "is_write" = CASE WHEN e."risk_level" IN ('write', 'destructive') THEN true ELSE false END,
  "is_destructive" = CASE WHEN e."risk_level" = 'destructive' THEN true ELSE false END,
  "schema_hash" = coalesce(e."schema_hash", e."version_hash")
FROM "tool_connections" c
WHERE c."id" = e."connection_id";--> statement-breakpoint

UPDATE "tool_catalog_entries"
SET "tool_name" = "name"
WHERE "tool_name" IS NULL;--> statement-breakpoint

ALTER TABLE "tool_catalog_entries" ALTER COLUMN "tool_name" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "application_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "project_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "owner_scope_type" text DEFAULT 'connection' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "owner_scope_id" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "runtime_kind" text DEFAULT 'local_stdio' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "reuse_key" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "workspace_scope" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "credential_scope_hash" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "process_id" integer;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "command_template_key" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "last_health_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "idle_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint

UPDATE "tool_runtime_slots" AS s
SET "application_id" = c."application_id"
FROM "tool_connections" c
WHERE c."id" = s."connection_id"
  AND s."application_id" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "default_action" text DEFAULT 'deny' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_profile_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "selector_type" text NOT NULL,
  "effect" text DEFAULT 'include' NOT NULL,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "tool_name" text,
  "risk_level" text,
  "conditions" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_profile_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "policy_type" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "selectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "conditions" jsonb,
  "config" jsonb,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "idempotency_key" text,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "agent_id" uuid,
  "issue_id" uuid,
  "run_id" uuid,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "tool_name" text NOT NULL,
  "arguments_hash" text,
  "arguments_summary" jsonb,
  "policy_decision" text,
  "matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approval_state" text DEFAULT 'not_required' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "upstream_request_id" text,
  "result_hash" text,
  "result_summary" jsonb,
  "result_size_bytes" integer,
  "result_artifact_id" uuid,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_action_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "invocation_id" uuid NOT NULL,
  "issue_id" uuid,
  "interaction_id" uuid,
  "approval_id" uuid,
  "status" text DEFAULT 'pending' NOT NULL,
  "canonical_arguments_hash" text NOT NULL,
  "canonical_arguments_summary" jsonb NOT NULL,
  "signed_arguments" text,
  "preview_markdown" text,
  "requested_by_agent_id" uuid,
  "requested_by_user_id" text,
  "resolved_by_agent_id" uuid,
  "resolved_by_user_id" text,
  "decided_by_agent_id" uuid,
  "decided_by_user_id" text,
  "decided_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_call_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "agent_id" uuid,
  "run_id" uuid,
  "issue_id" uuid,
  "application_id" uuid,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "invocation_id" uuid,
  "action_request_id" uuid,
  "runtime_slot_id" uuid,
  "tool_name" text,
  "decision" text,
  "matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason_code" text,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "latency_ms" integer,
  "arguments_summary" jsonb,
  "request_hash" text,
  "request_summary" jsonb,
  "result_hash" text,
  "result_summary" jsonb,
  "result_size_bytes" integer,
  "redaction_plan" jsonb,
  "rate_limit_state" jsonb,
  "metadata" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_rate_limit_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "policy_id" uuid,
  "counter_key" text NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" text NOT NULL,
  "window_kind" text NOT NULL,
  "window_start_at" timestamp with time zone NOT NULL,
  "limit" integer NOT NULL,
  "remaining" integer NOT NULL,
  "reset_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_plugin_id_plugins_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_owner_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_reviewed_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profiles_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profiles" ADD CONSTRAINT "tool_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_profile_id_tool_profiles_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_entries_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_profile_id_tool_profiles_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_profile_bindings_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_policies_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_policies_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_project_workspace_id_project_workspaces_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_execution_workspace_id_execution_workspaces_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_invocation_id_tool_invocations_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_interaction_id_issue_thread_interactions_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_approval_id_approvals_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_requested_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_resolved_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_action_requests_decided_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_invocation_id_tool_invocations_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_action_request_id_tool_action_requests_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_action_request_id_tool_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."tool_action_requests"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_runtime_slot_id_tool_runtime_slots_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_runtime_slot_id_tool_runtime_slots_id_fk" FOREIGN KEY ("runtime_slot_id") REFERENCES "public"."tool_runtime_slots"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_rate_limit_counters_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_rate_limit_counters_policy_id_tool_policies_id_fk') THEN
    ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_policy_id_tool_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tool_applications_company_status_idx" ON "tool_applications" USING btree ("company_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_applications_company_key_uq" ON "tool_applications" USING btree ("company_id", "application_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_connections_company_enabled_idx" ON "tool_connections" USING btree ("company_id", "enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_application_idx" ON "tool_catalog_entries" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_company_status_idx" ON "tool_catalog_entries" USING btree ("company_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profiles_company_status_idx" ON "tool_profiles" USING btree ("company_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profiles_company_key_uq" ON "tool_profiles" USING btree ("company_id", "profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profiles_company_name_uq" ON "tool_profiles" USING btree ("company_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profile_entries_company_profile_idx" ON "tool_profile_entries" USING btree ("company_id", "profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profile_entries_application_idx" ON "tool_profile_entries" USING btree ("company_id", "application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profile_entries_connection_idx" ON "tool_profile_entries" USING btree ("company_id", "connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profile_entries_catalog_entry_idx" ON "tool_profile_entries" USING btree ("company_id", "catalog_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_profile_bindings_company_target_idx" ON "tool_profile_bindings" USING btree ("company_id", "target_type", "target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_profile_bindings_target_profile_uq" ON "tool_profile_bindings" USING btree ("company_id", "target_type", "target_id", "profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_policies_company_enabled_idx" ON "tool_policies" USING btree ("company_id", "enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_policies_company_type_idx" ON "tool_policies" USING btree ("company_id", "policy_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_policies_company_name_uq" ON "tool_policies" USING btree ("company_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_execution_workspace_idx" ON "tool_runtime_slots" USING btree ("company_id", "execution_workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_company_created_idx" ON "tool_invocations" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_run_idx" ON "tool_invocations" USING btree ("company_id", "run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_issue_idx" ON "tool_invocations" USING btree ("company_id", "issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_invocations_company_idempotency_uq" ON "tool_invocations" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_requests_company_status_idx" ON "tool_action_requests" USING btree ("company_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_requests_invocation_idx" ON "tool_action_requests" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_requests_issue_idx" ON "tool_action_requests" USING btree ("company_id", "issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_company_created_idx" ON "tool_call_events" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_run_idx" ON "tool_call_events" USING btree ("company_id", "run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_issue_idx" ON "tool_call_events" USING btree ("company_id", "issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_invocation_idx" ON "tool_call_events" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_rate_limit_counters_company_idx" ON "tool_rate_limit_counters" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_rate_limit_counters_window_uq" ON "tool_rate_limit_counters" USING btree ("company_id", "policy_id", "counter_key", "window_kind", "window_start_at");--> statement-breakpoint

INSERT INTO "tool_applications" (
  "company_id",
  "application_key",
  "name",
  "type",
  "status",
  "plugin_id",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  c."id",
  'paperclip_plugin:' || p."plugin_key",
  coalesce(p."manifest_json"->>'name', p."plugin_key"),
  'paperclip_plugin',
  'active',
  p."id",
  jsonb_build_object('source', 'plugin_backfill', 'pluginKey', p."plugin_key"),
  now(),
  now()
FROM "companies" c
CROSS JOIN "plugins" p
WHERE jsonb_array_length(coalesce(p."manifest_json"->'tools', '[]'::jsonb)) > 0
ON CONFLICT ("company_id", "name") DO NOTHING;--> statement-breakpoint

INSERT INTO "tool_connections" (
  "company_id",
  "application_id",
  "name",
  "connection_kind",
  "transport",
  "status",
  "enabled",
  "config",
  "transport_config",
  "credential_refs",
  "credential_secret_refs",
  "health_status",
  "created_at",
  "updated_at"
)
SELECT
  a."company_id",
  a."id",
  'Plugin: ' || coalesce(p."manifest_json"->>'name', p."plugin_key"),
  'managed',
  'remote_http',
  'active',
  true,
  jsonb_build_object('pluginKey', p."plugin_key", 'type', 'paperclip_plugin'),
  jsonb_build_object('pluginKey', p."plugin_key", 'type', 'paperclip_plugin'),
  '[]'::jsonb,
  '[]'::jsonb,
  'ok',
  now(),
  now()
FROM "tool_applications" a
JOIN "plugins" p ON p."id" = a."plugin_id"
WHERE a."type" = 'paperclip_plugin'
  AND NOT EXISTS (
    SELECT 1 FROM "tool_connections" existing
    WHERE existing."company_id" = a."company_id"
      AND existing."application_id" = a."id"
  )
ON CONFLICT ("company_id", "name") DO NOTHING;--> statement-breakpoint

INSERT INTO "tool_catalog_entries" (
  "company_id",
  "application_id",
  "connection_id",
  "entry_kind",
  "name",
  "tool_name",
  "title",
  "description",
  "input_schema",
  "annotations",
  "risk_level",
  "is_read_only",
  "is_write",
  "is_destructive",
  "status",
  "version_hash",
  "schema_hash",
  "first_seen_at",
  "last_seen_at",
  "created_at",
  "updated_at"
)
SELECT
  c."company_id",
  c."application_id",
  c."id",
  'tool',
  tool.value->>'name',
  tool.value->>'name',
  coalesce(tool.value->>'displayName', tool.value->>'title'),
  tool.value->>'description',
  coalesce(tool.value->'parametersSchema', '{}'::jsonb),
  '{}'::jsonb,
  'read',
  true,
  false,
  false,
  'active',
  md5(tool.value::text),
  md5(tool.value::text),
  now(),
  now(),
  now(),
  now()
FROM "tool_connections" c
JOIN "tool_applications" a ON a."id" = c."application_id"
JOIN "plugins" p ON p."id" = a."plugin_id"
CROSS JOIN LATERAL jsonb_array_elements(coalesce(p."manifest_json"->'tools', '[]'::jsonb)) AS tool(value)
WHERE a."type" = 'paperclip_plugin'
  AND tool.value ? 'name'
ON CONFLICT ("connection_id", "name") DO NOTHING;--> statement-breakpoint

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  memberships."company_id",
  memberships."principal_type",
  memberships."principal_id",
  permissions."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" memberships
JOIN (
  VALUES
    ('tools:admin'),
    ('tools:manage_connections'),
    ('tools:manage_profiles'),
    ('tools:view_audit'),
    ('tools:manage_runtime')
) AS permissions("permission_key") ON true
WHERE memberships."principal_type" = 'user'
  AND memberships."status" = 'active'
  AND memberships."membership_role" IN ('owner', 'admin')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  agents."company_id",
  'agent',
  agents."id",
  permissions."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "agents"
JOIN (
  VALUES
    ('tools:admin'),
    ('tools:manage_connections'),
    ('tools:manage_profiles'),
    ('tools:view_audit'),
    ('tools:manage_runtime')
) AS permissions("permission_key") ON true
WHERE agents."role" IN ('ceo', 'cto')
  AND agents."status" NOT IN ('pending_approval', 'terminated')
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
