ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "operator_digest_enabled" boolean NOT NULL DEFAULT true;
