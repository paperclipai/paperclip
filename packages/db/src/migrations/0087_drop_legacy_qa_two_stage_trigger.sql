-- Remove a legacy database trigger that forced every status -> in_review
-- transition through QA (Code) and every code_approved transition through QA
-- (Browser). The application-level execution policy now owns review routing.
-- Leaving this trigger installed corrupts manual/human review handoffs by
-- reassigning issues to QA while preserving assignee_user_id.

DROP TRIGGER IF EXISTS qa_two_stage_flow_trigger ON issues;
DROP FUNCTION IF EXISTS handle_qa_two_stage_flow();
