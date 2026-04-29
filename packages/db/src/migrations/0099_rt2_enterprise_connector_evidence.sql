CREATE TABLE IF NOT EXISTS "rt2_enterprise_connector_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "connector_kind" text NOT NULL,
  "evidence_type" text NOT NULL,
  "status" text NOT NULL,
  "provider" text,
  "source_label" text,
  "preview_evidence_id" uuid,
  "fingerprint" text,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rollback_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "failure_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_enterprise_connector_evidence_company_latest_idx"
  ON "rt2_enterprise_connector_evidence" (
    "company_id",
    "connector_kind",
    "evidence_type",
    "created_at"
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_enterprise_connector_evidence_company_preview_idx"
  ON "rt2_enterprise_connector_evidence" ("company_id", "preview_evidence_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_enterprise_connector_evidence_fingerprint_idx"
  ON "rt2_enterprise_connector_evidence" ("fingerprint");
