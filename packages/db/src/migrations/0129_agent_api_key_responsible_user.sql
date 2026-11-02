ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
UPDATE "agent_api_keys" AS key
SET "responsible_user_id" = created_by."responsible_user_id"
FROM (
  SELECT DISTINCT ON (key_id)
    key_id,
    responsible_user_id
  FROM (
    SELECT
      log.details ->> 'keyId' AS key_id,
      log.actor_id AS responsible_user_id,
      log.created_at
    FROM "activity_log" AS log
    WHERE log.action = 'agent.key_created'
      AND log.actor_type = 'user'
      AND log.details ->> 'keyId' IS NOT NULL
      AND log.actor_id IS NOT NULL
      AND log.actor_id <> ''

    UNION ALL

    SELECT
      log.entity_id AS key_id,
      request.approved_by_user_id AS responsible_user_id,
      log.created_at
    FROM "activity_log" AS log
    INNER JOIN "join_requests" AS request
      ON request.id::text = log.details ->> 'joinRequestId'
    WHERE log.action = 'agent_api_key.claimed'
      AND log.entity_type = 'agent_api_key'
      AND log.entity_id IS NOT NULL
      AND request.approved_by_user_id IS NOT NULL
      AND request.approved_by_user_id <> ''
  ) AS candidates
  WHERE responsible_user_id IS NOT NULL
    AND responsible_user_id <> ''
  ORDER BY key_id, created_at ASC
) AS created_by
WHERE key.id::text = created_by.key_id
  AND key.responsible_user_id IS NULL;
