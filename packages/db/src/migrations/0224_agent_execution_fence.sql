ALTER TABLE "agents" ADD COLUMN "execution_fence_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_status" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_pause_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_restore_status" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_actor_user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_finalizer_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_execution_finalization_order_check" CHECK (
  "execution_finalized_at" is null or "execution_finalizer_completed_at" is not null
);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_execution_fence_state_check" CHECK ((
        "agents"."execution_fence_id" is null
        and "agents"."execution_fence_prior_status" is null
        and "agents"."execution_fence_prior_pause_reason" is null
        and "agents"."execution_fence_prior_paused_at" is null
        and "agents"."execution_fence_restore_status" is null
        and "agents"."execution_fence_reason" is null
        and "agents"."execution_fence_actor_user_id" is null
        and "agents"."execution_fence_acquired_at" is null
      ) or (
        "agents"."execution_fence_id" is not null
        and "agents"."status" = 'paused'
        and "agents"."execution_fence_prior_status" is not null
        and "agents"."execution_fence_restore_status" is not null
        and "agents"."execution_fence_reason" is not null
        and "agents"."execution_fence_acquired_at" is not null
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_heartbeat_execution_fence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_fence_agent_id uuid;
  active_fence_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."agent_id" is distinct from NEW."agent_id" THEN
    PERFORM 1
    FROM "agents" agent
    WHERE agent."id" IN (OLD."agent_id", NEW."agent_id")
    ORDER BY agent."id"
    FOR UPDATE;

    SELECT agent."id", agent."execution_fence_id"
    INTO active_fence_agent_id, active_fence_id
    FROM "agents" agent
    WHERE agent."id" IN (OLD."agent_id", NEW."agent_id")
      AND agent."execution_fence_id" is not null
    ORDER BY agent."id"
    LIMIT 1;
  ELSE
    SELECT agent."id", agent."execution_fence_id"
    INTO active_fence_agent_id, active_fence_id
    FROM "agents" agent
    WHERE agent."id" = NEW."agent_id"
    FOR UPDATE;
  END IF;

  IF active_fence_id is null THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."agent_id" = NEW."agent_id"
    AND OLD."started_at" is not null
    AND OLD."execution_finalized_at" is null
    AND (
      (
        OLD."status" = 'running'
        AND NEW."execution_finalized_at" is null
        AND (
          NEW."status" = 'running'
          OR NEW."status" NOT IN ('queued', 'running', 'scheduled_retry')
        )
      )
      OR (
        OLD."status" NOT IN ('queued', 'running', 'scheduled_retry')
        AND NEW."status" NOT IN ('queued', 'running', 'scheduled_retry')
      )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Agent % is protected by execution fence %', active_fence_agent_id, active_fence_id
    USING ERRCODE = '55000',
          HINT = 'Wait for the exact fence to be released before admitting or changing agent execution work.';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_wakeup_execution_fence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_fence_agent_id uuid;
  active_fence_id uuid;
  finalizer_write_allowed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."agent_id" is distinct from NEW."agent_id" THEN
    PERFORM 1
    FROM "agents" agent
    WHERE agent."id" IN (OLD."agent_id", NEW."agent_id")
    ORDER BY agent."id"
    FOR UPDATE;

    SELECT agent."id", agent."execution_fence_id"
    INTO active_fence_agent_id, active_fence_id
    FROM "agents" agent
    WHERE agent."id" IN (OLD."agent_id", NEW."agent_id")
      AND agent."execution_fence_id" is not null
    ORDER BY agent."id"
    LIMIT 1;
  ELSE
    SELECT agent."id", agent."execution_fence_id"
    INTO active_fence_agent_id, active_fence_id
    FROM "agents" agent
    WHERE agent."id" = NEW."agent_id"
    FOR UPDATE;
  END IF;

  IF active_fence_id is null THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."agent_id" = NEW."agent_id"
    AND OLD."run_id" is not null
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM "heartbeat_runs" run
      WHERE run."id" = OLD."run_id"
        AND run."agent_id" = NEW."agent_id"
        AND run."started_at" is not null
        AND run."execution_finalized_at" is null
        AND run."status" NOT IN ('queued', 'running', 'scheduled_retry')
        AND NEW."run_id" is not distinct from OLD."run_id"
        AND NEW."payload" is not distinct from OLD."payload"
        AND NEW."status" = CASE
          WHEN run."status" = 'succeeded' THEN 'completed'
          ELSE run."status"
        END
    ) INTO finalizer_write_allowed;
  END IF;

  IF finalizer_write_allowed THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Agent % is protected by execution fence %', active_fence_agent_id, active_fence_id
    USING ERRCODE = '55000',
          HINT = 'Wait for the exact fence to be released before admitting or changing agent execution work.';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_wakeup_requests_execution_fence_guard" ON "agent_wakeup_requests";--> statement-breakpoint
CREATE TRIGGER "agent_wakeup_requests_execution_fence_guard"
BEFORE INSERT OR UPDATE OF "agent_id", "status", "payload", "run_id" ON "agent_wakeup_requests"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_wakeup_execution_fence"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_environment_lease_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalizer_completed_at timestamp with time zone;
BEGIN
  IF NEW."heartbeat_run_id" is null OR NEW."status" <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT run."execution_finalizer_completed_at"
  INTO finalizer_completed_at
  FROM "heartbeat_runs" run
  WHERE run."id" = NEW."heartbeat_run_id"
  FOR UPDATE;

  IF finalizer_completed_at is not null THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer', NEW."heartbeat_run_id"
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "environment_leases_finalized_run_guard" ON "environment_leases";--> statement-breakpoint
CREATE TRIGGER "environment_leases_finalized_run_guard"
BEFORE INSERT OR UPDATE OF "heartbeat_run_id", "status" ON "environment_leases"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_environment_lease_attachment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_issue_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalizer_completed_at timestamp with time zone;
BEGIN
  IF NEW."execution_run_id" is null THEN
    RETURN NEW;
  END IF;

  SELECT run."execution_finalizer_completed_at"
  INTO finalizer_completed_at
  FROM "heartbeat_runs" run
  WHERE run."id" = NEW."execution_run_id"
  FOR UPDATE;

  IF finalizer_completed_at is not null THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer', NEW."execution_run_id"
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issues_finalized_run_guard" ON "issues";--> statement-breakpoint
CREATE TRIGGER "issues_finalized_run_guard"
BEFORE INSERT OR UPDATE OF "execution_run_id" ON "issues"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_issue_attachment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_runtime_service_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalizer_completed_at timestamp with time zone;
BEGIN
  IF NEW."started_by_run_id" is null
    OR NEW."lifecycle" <> 'ephemeral'
    OR NEW."status" NOT IN ('provisioning', 'starting', 'running')
  THEN
    RETURN NEW;
  END IF;

  SELECT run."execution_finalizer_completed_at"
  INTO finalizer_completed_at
  FROM "heartbeat_runs" run
  WHERE run."id" = NEW."started_by_run_id"
  FOR UPDATE;

  IF finalizer_completed_at is not null THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer', NEW."started_by_run_id"
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_runtime_services_finalized_run_guard" ON "workspace_runtime_services";--> statement-breakpoint
CREATE TRIGGER "workspace_runtime_services_finalized_run_guard"
BEFORE INSERT OR UPDATE OF "started_by_run_id", "lifecycle", "status" ON "workspace_runtime_services"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_runtime_service_attachment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_fenced_agent_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."execution_fence_id" is not null THEN
    RAISE EXCEPTION 'Agent % is protected by execution fence %', OLD."id", OLD."execution_fence_id"
      USING ERRCODE = '55000',
            HINT = 'Release the exact execution fence before deleting the agent.';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_fenced_agent_execution_record_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_fence_id uuid;
BEGIN
  SELECT "execution_fence_id"
  INTO active_fence_id
  FROM "agents"
  WHERE "id" = OLD."agent_id"
  FOR UPDATE;

  IF active_fence_id is not null THEN
    RAISE EXCEPTION 'Agent % is protected by execution fence %', OLD."agent_id", active_fence_id
      USING ERRCODE = '55000',
            HINT = 'Release the exact execution fence before deleting execution records.';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_execution_fence_delete_guard" ON "agents";--> statement-breakpoint
CREATE TRIGGER "agents_execution_fence_delete_guard"
BEFORE DELETE ON "agents"
FOR EACH ROW
EXECUTE FUNCTION "guard_fenced_agent_delete"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_delete_guard" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_execution_fence_delete_guard"
BEFORE DELETE ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_fenced_agent_execution_record_delete"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_wakeup_requests_execution_fence_delete_guard" ON "agent_wakeup_requests";--> statement-breakpoint
CREATE TRIGGER "agent_wakeup_requests_execution_fence_delete_guard"
BEFORE DELETE ON "agent_wakeup_requests"
FOR EACH ROW
EXECUTE FUNCTION "guard_fenced_agent_execution_record_delete"();
