-- Consolidates the development runtime-service migrations. Existing allocations,
-- service identities, credentials, share hashes, and deletion receipts are retained.
CREATE TABLE IF NOT EXISTS "runtime_service_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reuse_key" text NOT NULL,
	"environment_lease_id" uuid,
	"execution_workspace_id" uuid,
	"cwd" text NOT NULL,
	"storage_usage" jsonb,
	"data_deletion_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_company_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_company_policy_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_data_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"requested_by_user_id" text,
	"authorization" jsonb DEFAULT '{"kind":"operator"}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"retry_at" timestamp with time zone,
	"provider_deleted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"request_key" text,
	"kind" text NOT NULL,
	"actor" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_preview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"endpoint_name" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"run_id" uuid,
	"share_id" uuid,
	"ticket_hash" text NOT NULL,
	"ticket_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"session_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"endpoint_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"creation_key" text,
	"created_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_service_task_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"issue_id" uuid,
	"host_cwd" text NOT NULL,
	"previous_task_workspace" jsonb,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"issue_id" uuid,
	"started_by_run_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"creation_key" text NOT NULL,
	"process_handoff_key" text,
	"process_handoff" jsonb,
	"spec" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"process_ref" jsonb,
	"endpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preview_last_signal_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"error" text,
	"stop_reason" text,
	"controller_id" text,
	"controller_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_service_shares" ADD COLUMN IF NOT EXISTS "creation_key" text;
--> statement-breakpoint
ALTER TABLE "runtime_service_shares" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "runtime_services" ADD COLUMN IF NOT EXISTS "preview_last_signal_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runtime_services" ADD COLUMN IF NOT EXISTS "process_handoff_key" text;
--> statement-breakpoint
ALTER TABLE "runtime_services" ADD COLUMN IF NOT EXISTS "process_handoff" jsonb;
--> statement-breakpoint
ALTER TABLE "runtime_service_task_workspaces" ALTER COLUMN "issue_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_service_task_workspaces" ADD COLUMN IF NOT EXISTS "previous_task_workspace" jsonb;
--> statement-breakpoint
ALTER TABLE "runtime_service_allocations" ADD COLUMN IF NOT EXISTS "storage_usage" jsonb;
--> statement-breakpoint
ALTER TABLE "runtime_service_allocations" ADD COLUMN IF NOT EXISTS "data_deletion_id" uuid;
--> statement-breakpoint
ALTER TABLE "runtime_service_data_deletions" ALTER COLUMN "requested_by_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_service_data_deletions" ADD COLUMN IF NOT EXISTS "authorization" jsonb DEFAULT '{"kind":"operator"}'::jsonb NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_task_workspaces'::regclass AND conname = 'runtime_service_task_workspaces_issue_id_issues_id_fk'::name AND confdeltype <> 'n') THEN
    ALTER TABLE "runtime_service_task_workspaces" DROP CONSTRAINT "runtime_service_task_workspaces_issue_id_issues_id_fk";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_location" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_allocations'::regclass AND conname = 'runtime_service_allocations_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_allocations" ADD CONSTRAINT "runtime_service_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_allocations'::regclass AND conname = 'runtime_service_allocations_environment_lease_id_environment_leases_id_fk'::name) THEN
    ALTER TABLE "runtime_service_allocations" ADD CONSTRAINT "runtime_service_allocations_environment_lease_id_environment_leases_id_fk" FOREIGN KEY ("environment_lease_id") REFERENCES "public"."environment_leases"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_allocations'::regclass AND conname = 'runtime_service_allocations_execution_workspace_id_execution_workspaces_id_fk'::name) THEN
    ALTER TABLE "runtime_service_allocations" ADD CONSTRAINT "runtime_service_allocations_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_company_policies'::regclass AND conname = 'runtime_service_company_policies_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_company_policies" ADD CONSTRAINT "runtime_service_company_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_company_policy_events'::regclass AND conname = 'runtime_service_company_policy_events_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_company_policy_events" ADD CONSTRAINT "runtime_service_company_policy_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_data_deletions'::regclass AND conname = 'runtime_service_data_deletions_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_data_deletions" ADD CONSTRAINT "runtime_service_data_deletions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_data_deletions'::regclass AND conname = 'runtime_service_data_deletions_allocation_id_runtime_service_allocations_id_fk'::name) THEN
    ALTER TABLE "runtime_service_data_deletions" ADD CONSTRAINT "runtime_service_data_deletions_allocation_id_runtime_service_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."runtime_service_allocations"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_data_deletions'::regclass AND conname = 'runtime_service_data_deletions_service_id_runtime_services_id_fk'::name) THEN
    ALTER TABLE "runtime_service_data_deletions" ADD CONSTRAINT "runtime_service_data_deletions_service_id_runtime_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."runtime_services"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_events'::regclass AND conname = 'runtime_service_events_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_events" ADD CONSTRAINT "runtime_service_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_events'::regclass AND conname = 'runtime_service_events_service_id_runtime_services_id_fk'::name) THEN
    ALTER TABLE "runtime_service_events" ADD CONSTRAINT "runtime_service_events_service_id_runtime_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."runtime_services"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_preview_sessions'::regclass AND conname = 'runtime_service_preview_sessions_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_preview_sessions" ADD CONSTRAINT "runtime_service_preview_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_preview_sessions'::regclass AND conname = 'runtime_service_preview_sessions_service_id_runtime_services_id_fk'::name) THEN
    ALTER TABLE "runtime_service_preview_sessions" ADD CONSTRAINT "runtime_service_preview_sessions_service_id_runtime_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."runtime_services"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_preview_sessions'::regclass AND conname = 'runtime_service_preview_sessions_run_id_heartbeat_runs_id_fk'::name) THEN
    ALTER TABLE "runtime_service_preview_sessions" ADD CONSTRAINT "runtime_service_preview_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_preview_sessions'::regclass AND conname = 'runtime_service_preview_sessions_share_id_runtime_service_shares_id_fk'::name) THEN
    ALTER TABLE "runtime_service_preview_sessions" ADD CONSTRAINT "runtime_service_preview_sessions_share_id_runtime_service_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."runtime_service_shares"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_shares'::regclass AND conname = 'runtime_service_shares_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_shares" ADD CONSTRAINT "runtime_service_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_shares'::regclass AND conname = 'runtime_service_shares_service_id_runtime_services_id_fk'::name) THEN
    ALTER TABLE "runtime_service_shares" ADD CONSTRAINT "runtime_service_shares_service_id_runtime_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."runtime_services"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_task_workspaces'::regclass AND conname = 'runtime_service_task_workspaces_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_service_task_workspaces" ADD CONSTRAINT "runtime_service_task_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_task_workspaces'::regclass AND conname = 'runtime_service_task_workspaces_allocation_id_runtime_service_allocations_id_fk'::name) THEN
    ALTER TABLE "runtime_service_task_workspaces" ADD CONSTRAINT "runtime_service_task_workspaces_allocation_id_runtime_service_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."runtime_service_allocations"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_service_task_workspaces'::regclass AND conname = 'runtime_service_task_workspaces_issue_id_issues_id_fk'::name) THEN
    ALTER TABLE "runtime_service_task_workspaces" ADD CONSTRAINT "runtime_service_task_workspaces_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_services'::regclass AND conname = 'runtime_services_company_id_companies_id_fk'::name) THEN
    ALTER TABLE "runtime_services" ADD CONSTRAINT "runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_services'::regclass AND conname = 'runtime_services_allocation_id_runtime_service_allocations_id_fk'::name) THEN
    ALTER TABLE "runtime_services" ADD CONSTRAINT "runtime_services_allocation_id_runtime_service_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."runtime_service_allocations"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_services'::regclass AND conname = 'runtime_services_issue_id_issues_id_fk'::name) THEN
    ALTER TABLE "runtime_services" ADD CONSTRAINT "runtime_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_services'::regclass AND conname = 'runtime_services_started_by_run_id_heartbeat_runs_id_fk'::name) THEN
    ALTER TABLE "runtime_services" ADD CONSTRAINT "runtime_services_started_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("started_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.runtime_services'::regclass AND conname = 'runtime_services_created_by_agent_id_agents_id_fk'::name) THEN
    ALTER TABLE "runtime_services" ADD CONSTRAINT "runtime_services_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_allocations_company_reuse_idx" ON "runtime_service_allocations" USING btree ("company_id","reuse_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_allocations_environment_idx" ON "runtime_service_allocations" USING btree ("environment_lease_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_allocations_workspace_idx" ON "runtime_service_allocations" USING btree ("execution_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_company_policy_events_request_idx" ON "runtime_service_company_policy_events" USING btree ("company_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_data_deletions_allocation_idx" ON "runtime_service_data_deletions" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_data_deletions_pending_idx" ON "runtime_service_data_deletions" USING btree ("state","retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_events_request_idx" ON "runtime_service_events" USING btree ("service_id","request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_events_service_time_idx" ON "runtime_service_events" USING btree ("company_id","service_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_preview_sessions_ticket_idx" ON "runtime_service_preview_sessions" USING btree ("ticket_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_preview_sessions_session_idx" ON "runtime_service_preview_sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_preview_sessions_expiry_idx" ON "runtime_service_preview_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_shares_token_idx" ON "runtime_service_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_shares_creation_idx" ON "runtime_service_shares" USING btree ("service_id","creation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_service_shares_service_idx" ON "runtime_service_shares" USING btree ("company_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_task_workspaces_task_idx" ON "runtime_service_task_workspaces" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_service_task_workspaces_allocation_idx" ON "runtime_service_task_workspaces" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_services_company_creation_idx" ON "runtime_services" USING btree ("company_id","creation_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_services_company_handoff_idx" ON "runtime_services" USING btree ("company_id","process_handoff_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_services_company_issue_idx" ON "runtime_services" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_services_allocation_idx" ON "runtime_services" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_services_reconcile_idx" ON "runtime_services" USING btree ("desired_state","controller_expires_at");
