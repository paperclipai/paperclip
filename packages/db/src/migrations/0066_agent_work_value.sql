ALTER TABLE "companies" ADD COLUMN "dev_value_hourly_rate_cents" integer DEFAULT 15000 NOT NULL;
ALTER TABLE "companies" ADD COLUMN "dev_value_tokens_per_hour" integer DEFAULT 100000 NOT NULL;
