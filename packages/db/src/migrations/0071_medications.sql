-- Medication tracking: log medications taken per day.
-- Multiple entries per day are allowed (one per medication).
-- Backs GET /medications and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "medication_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "medication_date" text NOT NULL,
  "medication_name" text NOT NULL,
  "dosage" text,
  "taken" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "medication_logs_user_company_date_idx" ON "medication_logs" ("user_id", "company_id", "medication_date");
