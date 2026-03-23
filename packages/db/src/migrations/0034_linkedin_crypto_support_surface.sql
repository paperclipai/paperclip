ALTER TABLE "business_configs"
  ADD COLUMN "linkedin_page_id" text,
  ADD COLUMN "linkedin_access_token_secret_name" text DEFAULT 'business-linkedin-access-token' NOT NULL,
  ADD COLUMN "crypto_provider" text,
  ADD COLUMN "crypto_wallet_address" text,
  ADD COLUMN "crypto_network" text,
  ADD COLUMN "crypto_webhook_secret_name" text DEFAULT 'business-crypto-webhook-secret' NOT NULL;
