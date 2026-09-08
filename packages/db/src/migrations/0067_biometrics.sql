-- Biometrics tracking: daily snapshot of weight, blood pressure, and resting heart rate.
-- One entry per user per day (upsert on conflict).
-- Backs GET /biometrics and companion POST/DELETE endpoints.

CREATE TABLE IF NOT EXISTS "biometric_readings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "measurement_date" text NOT NULL,
  "weight_kg" double precision,
  "systolic_bp" integer,
  "diastolic_bp" integer,
  "resting_heart_rate" integer,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "biometric_readings_user_company_idx" ON "biometric_readings" ("user_id", "company_id");
CREATE UNIQUE INDEX "biometric_readings_user_date_uq" ON "biometric_readings" ("company_id", "user_id", "measurement_date");
