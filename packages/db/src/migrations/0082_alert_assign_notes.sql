-- Alert Assignment and Notes (IUN-2885)
-- Adds assignee tracking to solaris_alerts and a new alert_notes table
-- for the Alert Management UX triage workflow (IUN-2881).

ALTER TABLE "solaris_alerts"
  ADD COLUMN IF NOT EXISTS "assignee_id"   text,
  ADD COLUMN IF NOT EXISTS "assignee_name" text;

CREATE TABLE IF NOT EXISTS "alert_notes" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id"    uuid NOT NULL REFERENCES "solaris_alerts"("id") ON DELETE CASCADE,
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "body"        text NOT NULL,
  "author_id"   text,
  "author_name" text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "alert_notes_alert_idx"
  ON "alert_notes" ("alert_id", "created_at");
