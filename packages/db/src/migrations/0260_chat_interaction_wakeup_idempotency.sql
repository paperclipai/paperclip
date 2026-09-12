-- The old partial index does not cover interaction:* keys, so this is
-- necessarily one prefix scan of agent_wakeup_requests. Drizzle applies the
-- migration transactionally: writers cannot observe the repair without the
-- replacement index, and the index cannot admit a new duplicate before the
-- repair commits. A temporary helper index would require the same large-table
-- scan while adding another transactional DDL lock, so the selective prefix
-- scan is the lower-lock upgrade path.
--
-- Preserve the most meaningful run-backed wake as the canonical key holder.
-- Terminal and actively executing duplicates keep their status and run link;
-- they are re-keyed outside the canonical namespace with audit metadata. Only
-- duplicate work that has not acquired a run and is safe to retire is marked
-- skipped. In particular, claimed/running work is never falsely cancelled.
WITH ranked AS (
  SELECT
    "id",
    "idempotency_key" AS "original_idempotency_key",
    "status" AS "previous_status",
    "run_id" AS "linked_run_id",
    first_value("id") OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "retained_id",
    row_number() OVER (
      PARTITION BY "company_id", "idempotency_key"
      ORDER BY
        CASE
          WHEN "run_id" IS NOT NULL AND "status" IN ('succeeded', 'completed', 'coalesced') THEN 0
          WHEN "run_id" IS NOT NULL AND "status" IN ('running', 'claimed') THEN 1
          WHEN "run_id" IS NOT NULL THEN 2
          WHEN "status" IN ('running', 'claimed') THEN 3
          WHEN "status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry') THEN 4
          ELSE 5
        END,
        "requested_at" ASC,
        "created_at" ASC,
        "id" ASC
    ) AS "ordinal"
  FROM "agent_wakeup_requests"
  WHERE "idempotency_key" LIKE 'interaction:%'
    AND "status" NOT IN ('skipped', 'failed', 'cancelled')
), duplicates AS (
  SELECT * FROM ranked WHERE "ordinal" > 1
)
UPDATE "agent_wakeup_requests" AS wake
SET
  "idempotency_key" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN duplicates."original_idempotency_key"
    ELSE 'historical-interaction-wake-duplicate:' || wake."id"::text
  END,
  "status" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN 'skipped'
    ELSE wake."status"
  END,
  "finished_at" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN COALESCE(wake."finished_at", now())
    ELSE wake."finished_at"
  END,
  "error" = CASE
    WHEN duplicates."linked_run_id" IS NULL
      AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
      THEN concat_ws(
        E'\n',
        NULLIF(wake."error", ''),
        'Safely retired duplicate by migration 0245; retained wake request ' || duplicates."retained_id"::text
      )
    ELSE wake."error"
  END,
  "payload" = COALESCE(wake."payload", '{}'::jsonb) || jsonb_build_object(
    'migrationDedupe', jsonb_build_object(
      'migration', '0245_chat_interaction_wakeup_idempotency',
      'retainedWakeRequestId', duplicates."retained_id",
      'originalIdempotencyKey', duplicates."original_idempotency_key",
      'previousStatus', duplicates."previous_status",
      'linkedRunId', duplicates."linked_run_id",
      'resolution', CASE
        WHEN duplicates."linked_run_id" IS NULL
          AND duplicates."previous_status" IN ('queued', 'deferred_issue_execution', 'retrying', 'scheduled_retry')
          THEN 'retired_unstarted_duplicate'
        ELSE 'rekeyed_preserving_execution_history'
      END
    )
  ),
  "updated_at" = now()
FROM duplicates
WHERE wake."id" = duplicates."id";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq";--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The selective duplicate repair above preserves historical evidence and the expanded predicate must commit atomically before board and external-chat resolvers share the canonical interaction wake key.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE ("agent_wakeup_requests"."idempotency_key" LIKE 'question-response:%' OR "agent_wakeup_requests"."idempotency_key" LIKE 'interaction:%') AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');
