-- Fix issue DELETE failures caused by FK constraints with ON DELETE NO ACTION.
-- Child data that is meaningless without the issue gets CASCADE.
-- Historical/financial data preserves records with SET NULL.
-- Self-referential parent_id uses SET NULL so child issues survive parent deletion.

ALTER TABLE "issue_comments"
  DROP CONSTRAINT IF EXISTS "issue_comments_issue_id_issues_id_fk",
  ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "issue_read_states"
  DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk",
  ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "issue_inbox_archives"
  DROP CONSTRAINT IF EXISTS "issue_inbox_archives_issue_id_issues_id_fk",
  ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "feedback_votes"
  DROP CONSTRAINT IF EXISTS "feedback_votes_issue_id_issues_id_fk",
  ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "cost_events"
  DROP CONSTRAINT IF EXISTS "cost_events_issue_id_issues_id_fk",
  ADD CONSTRAINT "cost_events_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "finance_events"
  DROP CONSTRAINT IF EXISTS "finance_events_issue_id_issues_id_fk",
  ADD CONSTRAINT "finance_events_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "issues"
  DROP CONSTRAINT IF EXISTS "issues_parent_id_issues_id_fk",
  ADD CONSTRAINT "issues_parent_id_issues_id_fk"
    FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
