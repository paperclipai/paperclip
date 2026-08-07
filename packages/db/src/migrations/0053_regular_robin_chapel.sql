SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "sso" jsonb DEFAULT '{}'::jsonb NOT NULL;
