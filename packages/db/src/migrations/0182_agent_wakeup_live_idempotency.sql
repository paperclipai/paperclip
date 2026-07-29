WITH ranked_live_duplicates AS (
  SELECT
    "id",
    "company_id",
    "agent_id",
    "idempotency_key",
    row_number() OVER (
      PARTITION BY "company_id", "agent_id", "idempotency_key"
      ORDER BY "requested_at" ASC, "created_at" ASC, "id" ASC
    ) AS "row_number",
    count(*) OVER (
      PARTITION BY "company_id", "agent_id", "idempotency_key"
    ) AS "duplicate_count"
  FROM "agent_wakeup_requests"
  WHERE "idempotency_key" is not null
    AND "status" in ('queued', 'claimed', 'completed', 'deferred_issue_execution')
),
canonical_live_rows AS (
  UPDATE "agent_wakeup_requests" AS canonical
  SET "coalesced_count" = canonical."coalesced_count" + ranked."duplicate_count" - 1,
      "updated_at" = now()
  FROM ranked_live_duplicates AS ranked
  WHERE canonical."id" = ranked."id"
    AND ranked."row_number" = 1
    AND ranked."duplicate_count" > 1
  RETURNING canonical."id"
),
coalesced_duplicate_rows AS (
  UPDATE "agent_wakeup_requests" AS duplicate
  SET "status" = 'coalesced',
      "finished_at" = coalesce(duplicate."finished_at", duplicate."claimed_at", duplicate."requested_at", duplicate."created_at", now()),
      "error" = concat_ws(E'\n', nullif(duplicate."error", ''), '0182_agent_wakeup_live_idempotency.sql coalesced a pre-existing duplicate live idempotency row before adding the unique index.'),
      "updated_at" = now()
  FROM ranked_live_duplicates AS ranked
  WHERE duplicate."id" = ranked."id"
    AND ranked."row_number" > 1
  RETURNING duplicate."id"
)
SELECT 1;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this live partial unique index is required to serialize wake dispatch idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_live_idempotency_uq"
  ON "agent_wakeup_requests" USING btree ("company_id", "agent_id", "idempotency_key")
  WHERE "idempotency_key" is not null
    and "status" in ('queued', 'claimed', 'completed', 'deferred_issue_execution');
