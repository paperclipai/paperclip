-- Phase 10: Add index on issue_read_states(issue_id, user_id) for correlated subquery performance
-- The existing compound unique index covers (company_id, issue_id, user_id).
-- This additional index speeds up non-company-scoped lookups in the list query.

CREATE INDEX IF NOT EXISTS "issue_read_states_issue_user_idx"
  ON "issue_read_states" ("issue_id", "user_id");
