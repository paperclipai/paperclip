CREATE INDEX IF NOT EXISTS "workspace_operations_company_issue_finalize_latest_idx"
  ON "workspace_operations" (
    "company_id",
    "issue_id",
    "started_at" DESC,
    "created_at" DESC,
    "id" DESC
  )
  WHERE "phase" = 'workspace_finalize' AND "issue_id" IS NOT NULL;

ALTER TABLE "workspace_operations"
  ADD COLUMN IF NOT EXISTS "terminal_barrier" boolean NOT NULL DEFAULT false;

ALTER TABLE "workspace_operations"
  ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;

-- Preserve the latest pre-migration finalize result for every issue. Older
-- rows are historical attempts; only the latest result can affect the issue's
-- terminal recovery state.
WITH latest_legacy_finalize AS (
  SELECT DISTINCT ON ("company_id", "issue_id") "id"
  FROM "workspace_operations"
  WHERE "phase" = 'workspace_finalize'
    AND "issue_id" IS NOT NULL
    AND "terminal_barrier" = false
  ORDER BY "company_id", "issue_id", "started_at" DESC, "created_at" DESC, "id" DESC
)
UPDATE "workspace_operations" operation
SET "terminal_barrier" = true
FROM latest_legacy_finalize latest
WHERE operation."id" = latest."id";

CREATE INDEX IF NOT EXISTS "workspace_operations_terminal_finalize_reconcile_idx"
  ON "workspace_operations" (
    "started_at",
    "id",
    "company_id",
    "issue_id"
  )
  WHERE "terminal_barrier" = true
    AND "reconciled_at" IS NULL
    AND "issue_id" IS NOT NULL;
