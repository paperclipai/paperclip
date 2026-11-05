-- 0251 was originally deployed as 0245. Its SQL bytes must remain unchanged:
-- migration history recognizes that deployed repair by hash. Correct only its
-- stored provenance here, without replaying duplicate retirement or rekeying.
-- The primary-key cursor visits every row once, including unrelated-only
-- batches. Query/write batches are bounded, but locks still last until commit.
-- paperclip:migration-safety-ignore loop-mutation-large-table: Existing agent_wakeup_requests primary key supports the strictly advancing UUID cursor. Each batch selects at most 500 IDs and updates only matching IDs and exact legacy repair metadata.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: Existing agent_wakeup_requests primary key supports ORDER BY id and id > last_id. No JSON predicate is used to search repeatedly for the next batch.
DO $provenance$
DECLARE
  last_id uuid;
  batch_ids uuid[];
  old_prefix constant text := 'Safely retired duplicate by migration 0245; retained wake request ';
  new_prefix constant text := 'Safely retired duplicate by migration 0251; retained wake request ';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  LOOP
    IF last_id IS NULL THEN
      SELECT ARRAY(SELECT "id" FROM "agent_wakeup_requests" ORDER BY "id" LIMIT 500) INTO batch_ids;
    ELSE
      SELECT ARRAY(SELECT "id" FROM "agent_wakeup_requests" WHERE "id" > last_id ORDER BY "id" LIMIT 500) INTO batch_ids;
    END IF;
    EXIT WHEN cardinality(batch_ids) = 0;

    UPDATE "agent_wakeup_requests" AS wake
    SET
      "payload" = jsonb_set(
        wake."payload",
        '{migrationDedupe,migration}',
        '"0251_chat_interaction_wakeup_idempotency"'::jsonb,
        false
      ),
      "error" = CASE
        WHEN wake."payload" #>> '{migrationDedupe,resolution}' = 'retired_unstarted_duplicate'
          AND right(wake."error", length(old_prefix) + 36) = old_prefix || (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}')
          AND (
            length(wake."error") = length(old_prefix) + 36
            OR substring(wake."error" FROM length(wake."error") - length(old_prefix) - 36 FOR 1) = E'\n'
          )
          THEN left(wake."error", length(wake."error") - length(old_prefix) - 36)
            || new_prefix || (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}')
        ELSE wake."error"
      END
    WHERE wake."id" = ANY(batch_ids)
      AND jsonb_typeof(wake."payload") = 'object'
      AND jsonb_typeof(wake."payload" -> 'migrationDedupe') = 'object'
      AND wake."payload" #>> '{migrationDedupe,migration}' = '0245_chat_interaction_wakeup_idempotency'
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,retainedWakeRequestId}') = 'string'
      AND (wake."payload" #>> '{migrationDedupe,retainedWakeRequestId}') ~ uuid_pattern
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,originalIdempotencyKey}') = 'string'
      AND wake."payload" #>> '{migrationDedupe,originalIdempotencyKey}' LIKE 'interaction:%'
      AND jsonb_typeof(wake."payload" #> '{migrationDedupe,previousStatus}') = 'string'
      AND wake."payload" #>> '{migrationDedupe,previousStatus}' NOT IN ('skipped', 'failed', 'cancelled')
      AND (
        wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
        OR (
          jsonb_typeof(wake."payload" #> '{migrationDedupe,linkedRunId}') = 'string'
          AND (wake."payload" #>> '{migrationDedupe,linkedRunId}') ~ uuid_pattern
        )
      )
      AND (
        (
          wake."payload" #>> '{migrationDedupe,resolution}' = 'retired_unstarted_duplicate'
          AND wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
          AND wake."payload" #>> '{migrationDedupe,previousStatus}' IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          AND wake."idempotency_key" = wake."payload" #>> '{migrationDedupe,originalIdempotencyKey}'
        )
        OR (
          wake."payload" #>> '{migrationDedupe,resolution}' = 'rekeyed_preserving_execution_history'
          AND NOT (
            wake."payload" #> '{migrationDedupe,linkedRunId}' = 'null'::jsonb
            AND wake."payload" #>> '{migrationDedupe,previousStatus}' IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          )
          AND wake."idempotency_key" = 'historical-interaction-wake-duplicate:' || wake."id"::text
        )
      );

    last_id := batch_ids[cardinality(batch_ids)];
  END LOOP;
END
$provenance$;
