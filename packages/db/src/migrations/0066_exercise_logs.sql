-- Exercise tracking: daily activity log with duration, type, and intensity
-- Backs GET /exercise and companion POST/DELETE endpoints.
-- Multiple entries per day are allowed (e.g. morning run + evening strength).

CREATE TABLE IF NOT EXISTS "exercise_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "exercise_date" text NOT NULL,
  "activity_type" text NOT NULL,
  "duration_minutes" integer NOT NULL,
  "intensity_level" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "exercise_logs_user_company_date_idx" ON "exercise_logs" ("user_id", "company_id", "exercise_date");
