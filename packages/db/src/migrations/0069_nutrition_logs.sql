-- Nutrition/hydration tracking: daily log of water intake, calories, and macros.
-- One entry per user per day (upsert on conflict).
-- Backs GET /nutrition and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "nutrition_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "log_date" text NOT NULL,
  "water_ml" integer NOT NULL,
  "calories" integer,
  "protein_g" integer,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "nutrition_logs_user_company_idx" ON "nutrition_logs" ("user_id", "company_id");
CREATE UNIQUE INDEX "nutrition_logs_user_date_uq" ON "nutrition_logs" ("company_id", "user_id", "log_date");
