-- Symptom tracking: log one or more symptoms per day with severity.
-- Multiple entries per day are allowed (e.g. headache + fatigue).
-- Backs GET /symptoms and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "symptom_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "symptom_date" text NOT NULL,
  "symptom" text NOT NULL,
  "severity" integer,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "symptom_logs_user_company_date_idx" ON "symptom_logs" ("user_id", "company_id", "symptom_date");
