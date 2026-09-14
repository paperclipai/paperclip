-- CAD Webhook DLQ (IUN-2880)
-- Dead-letter queue for failed inbound CAD webhook ingestion attempts.
-- Entries with status='pending' are eligible for auto-retry (up to 3 attempts);
-- status='exhausted' means all retries failed and admin replay is required.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cad_dlq_status') THEN
    CREATE TYPE "cad_dlq_status" AS ENUM ('pending', 'exhausted', 'replayed');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "cad_webhook_dlq" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"    uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "agency_code"   text NOT NULL,
  "incident_id"   text,
  "raw_payload"   text NOT NULL,
  "content_type"  text NOT NULL,
  "vendor"        text NOT NULL DEFAULT 'generic',
  "error_reason"  text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 1,
  "next_retry_at" timestamp with time zone,
  "status"        "cad_dlq_status" NOT NULL DEFAULT 'pending',
  "resolved_at"   timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "cad_webhook_dlq_status_retry_idx"
  ON "cad_webhook_dlq" ("status", "next_retry_at");

CREATE INDEX IF NOT EXISTS "cad_webhook_dlq_agency_incident_idx"
  ON "cad_webhook_dlq" ("agency_code", "incident_id");
