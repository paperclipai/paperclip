ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "activity_log_retention_days" integer;
