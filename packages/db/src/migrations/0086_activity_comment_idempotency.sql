CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_comment_added_comment_id_uq"
ON "activity_log" ("action", "entity_type", "entity_id", (details ->> 'commentId'))
WHERE "action" IN ('issue.comment_added', 'approval.comment_added')
  AND "details" ? 'commentId';
