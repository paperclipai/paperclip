CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_stale_session_rotation_alert_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'stale_session_rotation_alert'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
