-- Guard: routine_execution issues must have an assignee.
-- NOT VALID skips backfill validation on pre-existing orphan rows (AKS-1350 scan found 14);
-- future inserts must satisfy the constraint. Run VALIDATE CONSTRAINT after cleanup.
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_routine_execution_requires_assignee"
  CHECK (origin_kind != 'routine_execution' OR assignee_agent_id IS NOT NULL) NOT VALID;
