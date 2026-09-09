-- Lab results tracking: periodic blood-test biomarker entries.
-- One row per marker per draw (multiple markers from the same blood draw are separate rows).
-- Backs GET /lab-results and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "lab_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "marker_name" text NOT NULL,
  "loinc_code" text,
  "value" numeric NOT NULL,
  "unit" text NOT NULL,
  "optimal_min" numeric,
  "optimal_max" numeric,
  "measured_date" text NOT NULL,
  "source" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "lab_results_user_company_date_idx" ON "lab_results" ("user_id", "company_id", "measured_date");
CREATE INDEX "lab_results_user_company_marker_idx" ON "lab_results" ("user_id", "company_id", "marker_name");
