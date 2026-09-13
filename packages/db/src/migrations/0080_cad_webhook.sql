-- CAD Webhook Endpoint (IUN-2751)
-- Adds CAD-sourced dispatch event fields to solaris_alerts and creates
-- per-agency webhook config table for HMAC secret management.

-- Extend solaris_alerts with CAD dispatch fields
ALTER TABLE "solaris_alerts"
  ADD COLUMN IF NOT EXISTS "incident_id"   text UNIQUE,
  ADD COLUMN IF NOT EXISTS "incident_name" text,
  ADD COLUMN IF NOT EXISTS "incident_type" text,
  ADD COLUMN IF NOT EXISTS "reported_at"   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "source"        text NOT NULL DEFAULT 'solaris';

-- agency_webhook_configs: per-agency HMAC secrets for inbound CAD webhook auth
CREATE TABLE IF NOT EXISTS "agency_webhook_configs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"      uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agency_name"     text NOT NULL,
  "agency_code"     text NOT NULL,
  "webhook_secret"  text NOT NULL,
  "is_active"       boolean NOT NULL DEFAULT true,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "agency_webhook_configs_code_idx"
  ON "agency_webhook_configs" ("company_id", "agency_code")
  WHERE "is_active" = true;

-- Dev seed: SFFD, LAPD, CALFIRE for local testing
INSERT INTO "agency_webhook_configs" ("id", "company_id", "agency_name", "agency_code", "webhook_secret")
SELECT
  gen_random_uuid(),
  c.id,
  agency.name,
  agency.code,
  agency.secret
FROM "companies" c
CROSS JOIN (
  VALUES
    ('San Francisco Fire Department', 'SFFD', 'sffd-dev-secret-32bytes-padxxxxx'),
    ('Los Angeles Police Department', 'LAPD', 'lapd-dev-secret-32bytes-padxxxxx'),
    ('CAL FIRE',                       'CALFIRE', 'calf-dev-secret-32bytes-padxxxxx')
) AS agency(name, code, secret)
ON CONFLICT DO NOTHING;
