-- Tighten the routine_execution open-issue unique index so it gates duplicate
-- siblings at INSERT time, even before execution_run_id has been populated by
-- the heartbeat dispatcher. Previously the partial predicate required
-- execution_run_id IS NOT NULL, which left a window where two siblings sharing
-- (company_id, origin_id, origin_fingerprint) could be created with null
-- execution_run_id. A later UPDATE that populated execution_run_id (and kept
-- the row in the index) would then fail with 23505 — and every subsequent
-- write that left the row in the index, including reaper PATCHes setting
-- status='cancelled', would fail too. See GLA-281 / GLA-291.

-- Step 1: Hide newer duplicates so the tightened predicate has at most one row
-- per (company_id, origin_id, origin_fingerprint). Hiding (rather than
-- cancelling) keeps the rows recoverable for forensics. The oldest row is
-- preserved to keep activity history attached to the original issue id.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "origin_id", "origin_fingerprint"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "issues"
  WHERE "origin_kind" = 'routine_execution'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
)
UPDATE "issues"
SET
  "hidden_at" = now(),
  "updated_at" = now()
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);
--> statement-breakpoint

-- Step 2: Recreate the partial unique index without the
-- execution_run_id IS NOT NULL clause.
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');

-- Rollback (manual; not a drizzle automatic down):
--   DROP INDEX IF EXISTS "issues_open_routine_execution_uq";
--   CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
--           and "issues"."origin_id" is not null
--           and "issues"."hidden_at" is null
--           and "issues"."execution_run_id" is not null
--           and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
--   -- Restoring the hidden duplicates is operator-driven; identify rows by
--   -- (origin_kind='routine_execution', hidden_at within the migration apply
--   -- window) and decide per-row whether to set hidden_at = NULL.
