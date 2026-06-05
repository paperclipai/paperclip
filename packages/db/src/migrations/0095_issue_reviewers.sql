ALTER TABLE "issues"
  ADD COLUMN "reviewer_agent_id" uuid REFERENCES "agents"("id"),
  ADD COLUMN "reviewer_user_id" text;

INSERT INTO "activity_log" (
  "company_id",
  "actor_type",
  "actor_id",
  "action",
  "entity_type",
  "entity_id",
  "details"
)
SELECT
  i."company_id",
  'system',
  'migration:0095_issue_reviewers',
  'issue.reviewer_missing_audit_flagged',
  'issue',
  i."id"::text,
  jsonb_build_object(
    'identifier', i."identifier",
    'status', i."status",
    'reviewerAgentId', i."reviewer_agent_id",
    'reviewerUserId', i."reviewer_user_id",
    'reason', 'in_review_missing_reviewer_backfill'
  )
FROM "issues" AS i
WHERE i."status" = 'in_review'
  AND i."reviewer_agent_id" IS NULL
  AND NULLIF(BTRIM(COALESCE(i."reviewer_user_id", '')), '') IS NULL;
