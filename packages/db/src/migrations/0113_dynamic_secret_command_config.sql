ALTER TABLE "company_secrets"
  ADD COLUMN IF NOT EXISTS "dynamic_command" jsonb;
--> statement-breakpoint
ALTER TABLE "company_secret_bindings"
  ADD COLUMN IF NOT EXISTS "static_argv" jsonb NOT NULL DEFAULT '[]'::jsonb;
