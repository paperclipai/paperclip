CREATE TABLE IF NOT EXISTS "meditation_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "session_date" text NOT NULL,
  "duration_minutes" integer NOT NULL,
  "technique" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "meditation_logs_user_company_idx" ON "meditation_logs" ("user_id", "company_id");
CREATE INDEX "meditation_logs_date_idx" ON "meditation_logs" ("company_id", "user_id", "session_date");
