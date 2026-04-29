CREATE TABLE IF NOT EXISTS "rt2_capture_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "label" text NOT NULL,
  "installation_state" text DEFAULT 'not_installed' NOT NULL,
  "signing_status" text DEFAULT 'unsigned' NOT NULL,
  "signing_secret_hash" text,
  "last_inbound_event_at" timestamp with time zone,
  "last_inbound_event_id" text,
  "last_error_code" text,
  "blocked_reason" text,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_capture_sources_company_source_uq"
  ON "rt2_capture_sources" ("company_id", "source");
CREATE INDEX IF NOT EXISTS "rt2_capture_sources_company_state_idx"
  ON "rt2_capture_sources" ("company_id", "installation_state");

ALTER TABLE "rt2_capture_drafts"
  ADD COLUMN IF NOT EXISTS "source_installation_id" uuid REFERENCES "rt2_capture_sources"("id") ON DELETE set null,
  ADD COLUMN IF NOT EXISTS "source_signing_status" text DEFAULT 'unsigned' NOT NULL,
  ADD COLUMN IF NOT EXISTS "source_evidence" jsonb,
  ADD COLUMN IF NOT EXISTS "semantic_context" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "duplicate_warning" text;

CREATE INDEX IF NOT EXISTS "rt2_capture_drafts_source_installation_idx"
  ON "rt2_capture_drafts" ("company_id", "source_installation_id");
