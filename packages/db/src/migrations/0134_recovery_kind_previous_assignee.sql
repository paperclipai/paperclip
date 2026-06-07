-- §14 Separation of Disposition Authority (SAG-3377 Phase 2)
-- recoveryKind: disposition label carried on done/cancelled by a recovery owner (Condition C)
-- previousAssigneeAgentId: original assignee preserved when recovery owner takes over (Condition B)
ALTER TABLE "issues" ADD COLUMN "recovery_kind" text;
ALTER TABLE "issues" ADD COLUMN "previous_assignee_agent_id" uuid REFERENCES "agents"("id");
