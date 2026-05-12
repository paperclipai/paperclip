DELETE FROM "activity_log" loser
USING "activity_log" keeper
WHERE loser."action" = 'issue.thread_interaction_expired'
  AND keeper."action" = 'issue.thread_interaction_expired'
  AND loser."entity_type" = keeper."entity_type"
  AND loser."entity_id" = keeper."entity_id"
  AND loser."details" ? 'interactionId'
  AND keeper."details" ? 'interactionId'
  AND loser."details" ->> 'interactionId' = keeper."details" ->> 'interactionId'
  AND (
    loser."created_at" < keeper."created_at"
    OR (loser."created_at" = keeper."created_at" AND loser."id" < keeper."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_thread_interaction_expired_interaction_id_uq"
ON "activity_log" ("action", "entity_type", "entity_id", (details ->> 'interactionId'))
WHERE "action" = 'issue.thread_interaction_expired'
  AND "details" ? 'interactionId';
