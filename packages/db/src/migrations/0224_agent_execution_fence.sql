ALTER TABLE "agents" ADD COLUMN "execution_fence_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_status" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_pause_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_prior_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_restore_status" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_actor_user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_fence_acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_finalized_at" timestamp with time zone;--> statement-breakpoint
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
UPDATE "heartbeat_runs"
SET "execution_finalized_at" = coalesce("finished_at", "updated_at", now())
WHERE "execution_finalized_at" is null
  AND "started_at" is not null
  AND "status" NOT IN ('queued', 'running', 'scheduled_retry');--> statement-breakpoint
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
BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalized_at" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_wakeup_requests_execution_fence_guard" ON "agent_wakeup_requests";--> statement-breakpoint
CREATE TRIGGER "agent_wakeup_requests_execution_fence_guard"
BEFORE INSERT OR UPDATE OF "agent_id", "status", "payload", "run_id" ON "agent_wakeup_requests"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_wakeup_execution_fence"();--> statement-breakpoint
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
