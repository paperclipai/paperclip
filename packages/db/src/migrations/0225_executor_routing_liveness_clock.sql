-- Keep a liveness baseline independent of issue work duration. PostgreSQL records
-- this fast default at migration time for pre-existing rows, so imports with no
-- source started_at receive a safe fresh routing grace period without changing
-- their work-duration timestamp.
ALTER TABLE "issues" ADD COLUMN "executor_routing_started_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reset_issue_executor_routing_started_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.executor_routing_started_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issues_reset_executor_routing_started_at"
BEFORE UPDATE OF "assignee_agent_id", "assignee_user_id", "status" ON "issues"
FOR EACH ROW
WHEN (
  OLD.assignee_agent_id IS DISTINCT FROM NEW.assignee_agent_id
  OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id
  OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'in_progress')
)
EXECUTE FUNCTION public.reset_issue_executor_routing_started_at();
