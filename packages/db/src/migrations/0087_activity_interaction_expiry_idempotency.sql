CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_thread_interaction_expired_interaction_id_uq"
ON "activity_log" ("action", "entity_type", "entity_id", (details ->> 'interactionId'))
WHERE "action" = 'issue.thread_interaction_expired'
  AND "details" ? 'interactionId';
