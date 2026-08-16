LOCK TABLE "heartbeat_runs" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "agent_wakeup_requests" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_finalization_required" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_ownership_released_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "heartbeat_runs"
    WHERE "status" IN ('queued', 'running', 'scheduled_retry')
      OR (
        "execution_finalization_required" = true
        AND "started_at" is not null
        AND "execution_finalized_at" is null
      )
  ) OR EXISTS (
    SELECT 1
    FROM "agent_wakeup_requests"
    WHERE "status" IN ('queued', 'deferred_issue_execution', 'claimed')
  ) THEN
    RAISE EXCEPTION 'Agent execution fence migration requires zero admitted executions'
      USING ERRCODE = '55000',
            HINT = 'Stop admissions and drain wakeups, queued, running, scheduled-retry, and required-but-unfinalized executions before applying this migration.';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ALTER COLUMN "execution_finalization_required" SET DEFAULT true;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_heartbeat_run_finalization_requirement"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."execution_finalization_required" := true;
    RETURN NEW;
  END IF;

  IF OLD."execution_finalization_required" is distinct from NEW."execution_finalization_required" THEN
    RAISE EXCEPTION 'Heartbeat run finalization requirement is immutable'
      USING ERRCODE = '55000',
            HINT = 'Every post-cutover run must retain durable finalization tracking.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_execution_finalization_requirement_guard"
BEFORE INSERT OR UPDATE OF "execution_finalization_required" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_heartbeat_run_finalization_requirement"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "process_pid", "process_group_id", "process_ownership_released_at", "execution_finalizer_completed_at", "execution_finalized_at" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_process_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."process_ownership_released_at" is not null THEN
    RAISE EXCEPTION 'Heartbeat run process ownership must be released by the active execution path'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."execution_finalizer_completed_at" is not null
    AND (
      OLD."process_pid" is distinct from NEW."process_pid"
      OR OLD."process_group_id" is distinct from NEW."process_group_id"
      OR OLD."process_ownership_released_at" is distinct from NEW."process_ownership_released_at"
    )
  THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer', NEW."id"
      USING ERRCODE = '55000',
            HINT = 'Execution process metadata cannot change after durable finalizer completion.';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."process_ownership_released_at" is not null
    AND OLD."process_ownership_released_at" is distinct from NEW."process_ownership_released_at"
  THEN
    RAISE EXCEPTION 'Heartbeat run % already released its process ownership', NEW."id"
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."process_ownership_released_at" is null
    AND NEW."process_ownership_released_at" is not null
    AND (
      NEW."status" <> 'running'
      OR (NEW."process_pid" is null AND NEW."process_group_id" is null)
    )
  THEN
    RAISE EXCEPTION 'Heartbeat run % cannot release process ownership outside an active execution', NEW."id"
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_finalized_process_guard"
BEFORE INSERT OR UPDATE OF "process_pid", "process_group_id", "process_ownership_released_at" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_process_attachment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_issue_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalized_run_id uuid;
BEGIN
  IF NEW."execution_run_id" is null AND NEW."checkout_run_id" is null THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "heartbeat_runs" run
  WHERE run."id" IN (NEW."execution_run_id", NEW."checkout_run_id")
  ORDER BY run."id"
  FOR UPDATE;

  SELECT run."id"
  INTO finalized_run_id
  FROM "heartbeat_runs" run
  WHERE run."id" IN (NEW."execution_run_id", NEW."checkout_run_id")
    AND run."execution_finalizer_completed_at" is not null
  ORDER BY run."id"
  LIMIT 1;

  IF finalized_run_id is not null THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer', finalized_run_id
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issues_finalized_run_guard" ON "issues";--> statement-breakpoint
CREATE TRIGGER "issues_finalized_run_guard"
BEFORE INSERT OR UPDATE OF "execution_run_id", "checkout_run_id" ON "issues"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_issue_attachment"();
