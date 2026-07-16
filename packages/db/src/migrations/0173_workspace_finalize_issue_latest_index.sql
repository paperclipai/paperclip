CREATE INDEX IF NOT EXISTS "workspace_operations_company_issue_finalize_latest_idx"
  ON "workspace_operations" (
    "company_id",
    "issue_id",
    "started_at" DESC,
    "created_at" DESC,
    "id" DESC
  )
  WHERE "phase" = 'workspace_finalize' AND "issue_id" IS NOT NULL;
