INSERT INTO "issues" (
  "company_id",
  "title",
  "description",
  "status",
  "priority",
  "assignee_agent_id",
  "created_by_agent_id",
  "is_ceo_chat",
  "origin_kind",
  "origin_fingerprint"
)
SELECT
  a."company_id",
  'CEO Chat',
  'Conversation surface between the board (you) and the CEO. The CEO uses this thread to plan, ask questions, request approvals, spawn issues, and report back. This issue is excluded from the normal task lists.',
  'in_progress',
  'low',
  a."id",
  a."id",
  true,
  'manual',
  'default'
FROM "agents" a
WHERE a."role" = 'ceo'
  AND NOT EXISTS (
    SELECT 1
    FROM "issues" i
    WHERE i."company_id" = a."company_id"
      AND i."is_ceo_chat" = true
  );
