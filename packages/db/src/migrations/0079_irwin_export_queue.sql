-- IRWIN/CAD Export Queue (IUN-2725)
-- Queues Solaris alert events for export to the IRWIN national wildland fire reporting system.

CREATE TYPE "irwin_export_status" AS ENUM ('pending', 'in_flight', 'success', 'failed', 'skipped');
CREATE TYPE "irwin_incident_classification" AS ENUM ('reportable', 'informational');

CREATE TABLE "irwin_export_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "solaris_alert_id" uuid NOT NULL REFERENCES "solaris_alerts"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "status" "irwin_export_status" NOT NULL DEFAULT 'pending',
  "classification" "irwin_incident_classification" NOT NULL DEFAULT 'informational',
  "irwin_incident_id" text,
  "irwin_incident_number" text,
  "payload" jsonb NOT NULL,
  "last_error" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone,
  "exported_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Poller uses (status, next_attempt_at) to find ready work
CREATE INDEX "irwin_export_queue_status_next_attempt_idx"
  ON "irwin_export_queue" ("status", "next_attempt_at")
  WHERE "status" IN ('pending', 'failed');

CREATE INDEX "irwin_export_queue_company_created_idx"
  ON "irwin_export_queue" ("company_id", "created_at" DESC);

CREATE INDEX "irwin_export_queue_alert_idx"
  ON "irwin_export_queue" ("solaris_alert_id");
