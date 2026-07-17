ALTER TABLE "workspace_operations"
  ADD COLUMN IF NOT EXISTS "actor_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "actor_user_id" text,
  ADD COLUMN IF NOT EXISTS "actor_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "workspace_runtime_services"
  ADD COLUMN IF NOT EXISTS "started_by_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "started_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text,
  ADD COLUMN IF NOT EXISTS "last_controlled_by_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "last_controlled_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "last_controlled_by_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "last_controlled_at" timestamp with time zone;

ALTER TABLE "environment_leases"
  ADD COLUMN IF NOT EXISTS "actor_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "actor_user_id" text,
  ADD COLUMN IF NOT EXISTS "actor_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

ALTER TABLE "agent_wakeup_requests"
  ADD COLUMN IF NOT EXISTS "requested_by_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "requested_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "requested_by_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_operations_actor_agent_id_agents_id_fk') THEN
    ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_operations_actor_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_runtime_services_started_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_started_by_agent_id_agents_id_fk" FOREIGN KEY ("started_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_runtime_services_last_controlled_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_last_controlled_by_agent_id_agents_id_fk" FOREIGN KEY ("last_controlled_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_runtime_services_last_controlled_by_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_last_controlled_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_controlled_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'environment_leases_actor_agent_id_agents_id_fk') THEN
    ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'environment_leases_actor_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'agent_wakeup_requests_requested_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because these indexes back audit lookups by natural runtime and wake attribution rows.
CREATE INDEX IF NOT EXISTS "workspace_operations_company_actor_agent_started_idx" ON "workspace_operations" USING btree ("company_id", "actor_agent_id", "started_at");
CREATE INDEX IF NOT EXISTS "workspace_operations_company_actor_run_started_idx" ON "workspace_operations" USING btree ("company_id", "actor_run_id", "started_at");
CREATE INDEX IF NOT EXISTS "workspace_operations_company_responsible_user_started_idx" ON "workspace_operations" USING btree ("company_id", "responsible_user_id", "started_at");

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because these indexes back audit lookups by natural runtime service attribution rows.
CREATE INDEX IF NOT EXISTS "workspace_runtime_services_company_started_by_agent_idx" ON "workspace_runtime_services" USING btree ("company_id", "started_by_agent_id", "started_at");
CREATE INDEX IF NOT EXISTS "workspace_runtime_services_company_responsible_user_idx" ON "workspace_runtime_services" USING btree ("company_id", "responsible_user_id", "started_at");
CREATE INDEX IF NOT EXISTS "workspace_runtime_services_last_controlled_by_run_idx" ON "workspace_runtime_services" USING btree ("last_controlled_by_run_id");

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because these indexes back audit lookups by natural environment lease attribution rows.
CREATE INDEX IF NOT EXISTS "environment_leases_actor_run_idx" ON "environment_leases" USING btree ("actor_run_id");
CREATE INDEX IF NOT EXISTS "environment_leases_company_actor_agent_idx" ON "environment_leases" USING btree ("company_id", "actor_agent_id");
CREATE INDEX IF NOT EXISTS "environment_leases_company_responsible_user_idx" ON "environment_leases" USING btree ("company_id", "responsible_user_id");

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because these indexes back audit lookups by natural wake request attribution rows.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_requested_by_run_idx" ON "agent_wakeup_requests" USING btree ("requested_by_run_id");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this index backs audit lookups by natural wake request attribution rows.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_requested_by_agent_idx" ON "agent_wakeup_requests" USING btree ("company_id", "requested_by_agent_id", "requested_at");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this index backs audit lookups by natural wake request attribution rows.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_responsible_user_requested_idx" ON "agent_wakeup_requests" USING btree ("company_id", "responsible_user_id", "requested_at");
