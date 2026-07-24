-- Settings-surface policy (PR-1): per-section jsonb column for the instance
-- visibility policy, beside "general" and "experimental". Empty object means
-- "use defaults" (all company surfaces exposed), so existing rows keep
-- self-hosted behavior unchanged.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "visibility" jsonb DEFAULT '{}'::jsonb NOT NULL;
