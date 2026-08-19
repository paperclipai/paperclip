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
      OR (
        "status" NOT IN ('succeeded', 'interrupted', 'failed', 'cancelled', 'timed_out')
        AND ("process_pid" is not null OR "process_group_id" is not null)
      )
      OR EXISTS (
        SELECT 1
        FROM "issues" issue
        WHERE issue."execution_run_id" = "heartbeat_runs"."id"
          OR issue."checkout_run_id" = "heartbeat_runs"."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "environment_leases" lease
        WHERE lease."heartbeat_run_id" = "heartbeat_runs"."id"
          AND lease."status" = 'active'
      )
      OR EXISTS (
        SELECT 1
        FROM "workspace_runtime_services" runtime_service
        WHERE runtime_service."started_by_run_id" = "heartbeat_runs"."id"
          AND runtime_service."lifecycle" = 'ephemeral'
          AND runtime_service."status" IN ('provisioning', 'starting', 'running')
      )
  ) OR EXISTS (
    SELECT 1
    FROM "agent_wakeup_requests"
    WHERE "status" IN ('queued', 'deferred_issue_execution', 'claimed')
  ) THEN
    RAISE EXCEPTION 'Agent execution fence migration requires zero admitted executions'
      USING ERRCODE = '55000',
            HINT = 'Stop admissions and drain wakeups, queued, running, scheduled-retry, required-but-unfinalized executions, and legacy runs that still own execution resources before applying this migration.';
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
    AND (
      OLD."execution_finalizer_completed_at" is not null
      OR OLD."execution_finalization_required" = false
    )
    AND (
      OLD."process_pid" is distinct from NEW."process_pid"
      OR OLD."process_group_id" is distinct from NEW."process_group_id"
      OR OLD."process_ownership_released_at" is distinct from NEW."process_ownership_released_at"
    )
  THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer or is already exempt from finalization tracking', NEW."id"
      USING ERRCODE = '55000',
            HINT = 'Execution process metadata cannot change after durable finalizer completion or legacy cutover exemption.';
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
  closed_run_id uuid;
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
  INTO closed_run_id
  FROM "heartbeat_runs" run
  WHERE run."id" IN (NEW."execution_run_id", NEW."checkout_run_id")
    AND (
      run."execution_finalizer_completed_at" is not null
      OR run."execution_finalization_required" = false
    )
  ORDER BY run."id"
  LIMIT 1;

  IF closed_run_id is not null THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer or is already exempt from finalization tracking', closed_run_id
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion or legacy cutover exemption.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issues_finalized_run_guard" ON "issues";--> statement-breakpoint
CREATE TRIGGER "issues_finalized_run_guard"
BEFORE INSERT OR UPDATE OF "execution_run_id", "checkout_run_id" ON "issues"
FOR EACH ROW
EXECUTE FUNCTION "guard_finalized_run_issue_attachment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_environment_lease_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalizer_completed_at timestamp with time zone;
  finalization_required boolean;
BEGIN
  IF NEW."heartbeat_run_id" is null OR NEW."status" <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT run."execution_finalizer_completed_at", run."execution_finalization_required"
  INTO finalizer_completed_at, finalization_required
  FROM "heartbeat_runs" run
  WHERE run."id" = NEW."heartbeat_run_id"
  FOR UPDATE;

  IF finalizer_completed_at is not null OR finalization_required = false THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer or is already exempt from finalization tracking', NEW."heartbeat_run_id"
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion or legacy cutover exemption.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_finalized_run_runtime_service_attachment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalizer_completed_at timestamp with time zone;
  finalization_required boolean;
BEGIN
  IF NEW."started_by_run_id" is null
    OR NEW."lifecycle" <> 'ephemeral'
    OR NEW."status" NOT IN ('provisioning', 'starting', 'running')
  THEN
    RETURN NEW;
  END IF;

  SELECT run."execution_finalizer_completed_at", run."execution_finalization_required"
  INTO finalizer_completed_at, finalization_required
  FROM "heartbeat_runs" run
  WHERE run."id" = NEW."started_by_run_id"
  FOR UPDATE;

  IF finalizer_completed_at is not null OR finalization_required = false THEN
    RAISE EXCEPTION 'Heartbeat run % already completed its finalizer or is already exempt from finalization tracking', NEW."started_by_run_id"
      USING ERRCODE = '55000',
            HINT = 'Execution resources cannot be attached after durable finalizer completion or legacy cutover exemption.';
  END IF;

  RETURN NEW;
END;
$$;
