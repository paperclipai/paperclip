ALTER TABLE "business_configs"
  ADD COLUMN "resend_api_key_secret_name" text DEFAULT 'business-resend-api-key' NOT NULL,
  ADD COLUMN "resend_from_email" text,
  ADD COLUMN "github_repo_owner" text,
  ADD COLUMN "github_repo_name" text,
  ADD COLUMN "github_token_secret_name" text DEFAULT 'business-github-token' NOT NULL,
  ADD COLUMN "github_actions_workflow_name" text,
  ADD COLUMN "x_adapter_base_url" text,
  ADD COLUMN "x_adapter_api_key_secret_name" text DEFAULT 'business-x-adapter-api-key' NOT NULL,
  ADD COLUMN "sentry_dsn_secret_name" text DEFAULT 'business-sentry-dsn' NOT NULL,
  ADD COLUMN "uptime_kuma_url" text,
  ADD COLUMN "uptime_kuma_api_key_secret_name" text DEFAULT 'business-uptime-kuma-api-key' NOT NULL,
  ADD COLUMN "plausible_site_id" text,
  ADD COLUMN "plausible_api_key_secret_name" text DEFAULT 'business-plausible-api-key' NOT NULL;
