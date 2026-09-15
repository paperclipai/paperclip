-- Agency Trials (IUN-2912)
-- Supports self-serve agency registration: 30-day sandbox trial, 1k incident cap,
-- automated email sequence tracking.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agency_trial_status') THEN
    CREATE TYPE "agency_trial_status" AS ENUM ('active', 'expired', 'converted', 'cancelled');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agency_trial_email_type') THEN
    CREATE TYPE "agency_trial_email_type" AS ENUM ('welcome', 'day7', 'day25', 'upgrade_confirmation');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "agency_trials" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agency_webhook_config_id"  uuid NOT NULL REFERENCES "agency_webhook_configs"("id") ON DELETE CASCADE,
  "contact_email"             text NOT NULL,
  "contact_name"              text,
  "trial_status"              "agency_trial_status" NOT NULL DEFAULT 'active',
  "incident_count"            integer NOT NULL DEFAULT 0,
  "incident_cap"              integer NOT NULL DEFAULT 1000,
  "trial_started_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "trial_ends_at"             timestamp with time zone NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  "upgraded_at"               timestamp with time zone,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agency_trials_status_ends_idx"
  ON "agency_trials" ("trial_status", "trial_ends_at");

CREATE INDEX IF NOT EXISTS "agency_trials_config_idx"
  ON "agency_trials" ("agency_webhook_config_id");

CREATE TABLE IF NOT EXISTS "agency_trial_emails" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trial_id"   uuid NOT NULL REFERENCES "agency_trials"("id") ON DELETE CASCADE,
  "email_type" "agency_trial_email_type" NOT NULL,
  "sent_at"    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "agency_trial_emails_uniq_idx"
  ON "agency_trial_emails" ("trial_id", "email_type");
