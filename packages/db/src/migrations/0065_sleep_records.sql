-- Sleep tracking: daily sleep log with duration and quality
-- Backs GET /sleep and companion POST/DELETE endpoints

CREATE TABLE IF NOT EXISTS "sleep_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "sleep_date" text NOT NULL,
  "duration_minutes" integer NOT NULL,
  "quality" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "sleep_records_user_company_idx" ON "sleep_records" ("user_id", "company_id");
CREATE UNIQUE INDEX "sleep_records_user_date_uq" ON "sleep_records" ("company_id", "user_id", "sleep_date");
