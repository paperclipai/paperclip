-- Make agent_wakeup_requests.idempotency_key actually deduplicate.
--
-- The column existed but nothing enforced or read it: enqueueWakeup only wrote
-- it, and there was no unique index. Callers that passed a key got a field on
-- the row, not deduplication. Two concurrent enqueues could both miss the
-- other's not-yet-visible wake row and both queue a run with the same key.
--
-- Uniqueness is scoped to (company_id, idempotency_key) and restricted to the
-- statuses in which a wake still represents a run that took effect. Statuses
-- that mean "this wake did NOT happen" (skipped, coalesced, failed, cancelled)
-- stay outside the index on purpose: blocking a later wake because an earlier
-- one was skipped would silently drop work, which is worse than a duplicate
-- run.
--
-- Step 1: resolve any pre-existing duplicates so the index below can be
-- created. Keep one row per (company_id, idempotency_key) -- preferring one
-- that actually carries a run -- and release the key on the rest, recording
-- the released value in `error`.
--
-- Only the key is touched. Status and run linkage are left exactly as they
-- are, because a duplicate wake may still own a live queued run: rewriting its
-- status would either lie about that run or, worse, let the row re-enter the
-- index on its next lifecycle transition (queued -> claimed) and make the
-- claim fail with a unique violation. A row with a NULL key is outside the
-- partial index for good, whatever it does next.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, idempotency_key
      ORDER BY (run_id IS NULL), requested_at ASC, id ASC
    ) AS rn
  FROM agent_wakeup_requests
  WHERE idempotency_key IS NOT NULL
    AND status IN ('queued', 'claimed', 'deferred_issue_execution', 'completed')
)
UPDATE agent_wakeup_requests
SET
  idempotency_key = NULL,
  error = COALESCE(
    error,
    'Migration 0196 released duplicate idempotency_key ' || idempotency_key
      || '; the surviving wake for that key keeps it'
  ),
  updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint

-- Step 2: enforce uniqueness going forward. A partial unique index lets the
-- enqueue race lose cleanly: the losing INSERT is an ON CONFLICT DO NOTHING in
-- enqueueWakeup, which then resolves to the winner's run instead of creating a
-- second one.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the index is partial over a column that is NULL on the overwhelming majority of rows, so the build touches a small fraction of the table.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_company_idempotency_key_uq"
  ON "agent_wakeup_requests" ("company_id", "idempotency_key")
  WHERE idempotency_key IS NOT NULL
    AND status IN ('queued', 'claimed', 'deferred_issue_execution', 'completed');
