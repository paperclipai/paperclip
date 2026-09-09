-- Solaris CAP Alert Localization (IUN-2300)
-- Tables: solaris_orgs, solaris_alerts

CREATE TYPE "alert_severity" AS ENUM ('critical', 'warning', 'info');
CREATE TYPE "alert_dispatch_status" AS ENUM ('pending', 'translating', 'ready', 'failed');

CREATE TABLE IF NOT EXISTS "solaris_orgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "preferred_language" varchar(10) NOT NULL DEFAULT 'en',
  "contact_email" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "solaris_orgs_company_idx" ON "solaris_orgs" ("company_id", "is_active");

CREATE TABLE IF NOT EXISTS "solaris_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "org_id" uuid REFERENCES "solaris_orgs"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "severity" "alert_severity" NOT NULL DEFAULT 'info',
  "translated_bodies" jsonb,
  "dispatch_status" "alert_dispatch_status" NOT NULL DEFAULT 'pending',
  "cap_identifier" text,
  "incident_area" text,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "solaris_alerts_company_created_idx" ON "solaris_alerts" ("company_id", "created_at" DESC);
CREATE INDEX "solaris_alerts_org_idx" ON "solaris_alerts" ("org_id");
CREATE INDEX "solaris_alerts_dispatch_status_idx" ON "solaris_alerts" ("dispatch_status") WHERE "dispatch_status" IN ('pending', 'translating');
