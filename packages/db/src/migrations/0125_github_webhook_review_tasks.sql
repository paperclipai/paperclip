CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_github_webhook_uq"
  ON "issues" ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'github:webhook'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL;
