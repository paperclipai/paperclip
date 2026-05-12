DELETE FROM "activity_log" loser
USING "activity_log" keeper
WHERE loser."action" IN ('issue.comment_added', 'approval.comment_added')
  AND keeper."action" = loser."action"
  AND loser."entity_type" = keeper."entity_type"
  AND loser."entity_id" = keeper."entity_id"
  AND loser."details" ? 'commentId'
  AND keeper."details" ? 'commentId'
  AND loser."details" ->> 'commentId' = keeper."details" ->> 'commentId'
  AND (
    loser."created_at" > keeper."created_at"
    OR (loser."created_at" = keeper."created_at" AND loser."id" > keeper."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_comment_added_comment_id_uq"
ON "activity_log" ("action", "entity_type", "entity_id", (details ->> 'commentId'))
WHERE "action" IN ('issue.comment_added', 'approval.comment_added')
  AND "details" ? 'commentId';
