-- Add per-user "requester" attribution to issues.
--
-- Motivation: extend tasks:view_all scoping (#6515) so that issues created on
-- behalf of a human (e.g. via paperclip-chat or any agent acting on a user's
-- request) attribute back to that user. The visibility resolver consumes this
-- column alongside created_by_user_id / assignee_user_id as part of the OR
-- clause that seeds the recursive parent_id descent.
--
-- Backfill: assume manual issues with a known created_by_user_id were
-- requested by their creator. Agent-spawned issues without created_by_user_id
-- stay NULL — the recursive CTE on parent_id will still pick them up through
-- their user-owned ancestor.

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "requested_by_user_id" text;

CREATE INDEX IF NOT EXISTS "issues_company_requested_by_user_idx"
  ON "issues" ("company_id", "requested_by_user_id");

UPDATE "issues"
SET "requested_by_user_id" = "created_by_user_id"
WHERE "requested_by_user_id" IS NULL
  AND "created_by_user_id" IS NOT NULL;
