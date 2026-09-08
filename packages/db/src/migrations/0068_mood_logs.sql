-- Mood tracking: daily snapshot of mood score, energy level, and notes.
-- One entry per user per day (upsert on conflict).
-- Backs GET /mood and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "mood_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "log_date" text NOT NULL,
  "mood_score" integer NOT NULL,
  "energy_level" integer,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "mood_logs_user_company_idx" ON "mood_logs" ("user_id", "company_id");
CREATE UNIQUE INDEX "mood_logs_user_date_uq" ON "mood_logs" ("company_id", "user_id", "log_date");
