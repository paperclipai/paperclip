UPDATE "issue_recovery_actions" AS recovery_action
SET
  "status" = 'resolved',
  "outcome" = CASE
    WHEN source_issue."status" = 'blocked' THEN 'blocked'
    ELSE 'restored'
  END,
  "resolution_note" = 'Auto-resolved during migration 0092: source issue already has a valid disposition',
  "resolved_at" = COALESCE(recovery_action."resolved_at", now()),
  "updated_at" = now()
FROM "issues" AS source_issue
WHERE recovery_action."source_issue_id" = source_issue."id"
  AND recovery_action."company_id" = source_issue."company_id"
  AND recovery_action."status" IN ('active', 'escalated')
  AND (
    source_issue."status" IN ('done', 'in_review', 'cancelled')
    OR (
      source_issue."status" = 'blocked'
      AND EXISTS (
        SELECT 1
        FROM "issue_relations" AS relation
        INNER JOIN "issues" AS blocker_issue
          ON blocker_issue."id" = relation."issue_id"
          AND blocker_issue."company_id" = relation."company_id"
        WHERE relation."company_id" = source_issue."company_id"
          AND relation."related_issue_id" = source_issue."id"
          AND relation."type" = 'blocks'
          AND blocker_issue."status" NOT IN ('done', 'cancelled')
      )
    )
  );
