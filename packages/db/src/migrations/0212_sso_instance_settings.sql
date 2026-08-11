ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "sso" jsonb DEFAULT '{}'::jsonb NOT NULL;
