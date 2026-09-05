-- Supplement tracking: supplement definitions + daily intake log
-- Backs GET /supplements/intake/:date and companion CRUD endpoints

CREATE TABLE IF NOT EXISTS "supplements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "dose" text NOT NULL,
  "unit" text NOT NULL DEFAULT 'mg',
  "scheduled_time" text NOT NULL DEFAULT '08:00',
  "active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "supplements_company_user_idx" ON "supplements" ("company_id", "user_id");

CREATE TABLE IF NOT EXISTS "supplement_intakes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "supplement_id" uuid NOT NULL REFERENCES "supplements"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "intake_date" text NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "taken_at" timestamp with time zone,
  "skipped_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "supplement_intakes_supplement_date_idx" ON "supplement_intakes" ("supplement_id", "intake_date");
CREATE INDEX "supplement_intakes_company_user_date_idx" ON "supplement_intakes" ("company_id", "user_id", "intake_date");
