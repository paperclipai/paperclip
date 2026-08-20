-- JAC-4538: Add publication artifact fields to approvals table.
--
-- The approvals schema was extended with artifact fields for the
-- publish_full_artifact approval type, but no migration was generated.
-- This caused column-not-found errors in tests that insert into approvals.
--
-- New columns:
--   artifact_kind     text (nullable) — kind of artifact (e.g. "work_product")
--   artifact_pointer  text (nullable) — storage pointer or URL to artifact
--   artifact_sha256   text (nullable) — SHA-256 hex digest of artifact content
--   redaction_state   text NOT NULL DEFAULT 'unredacted' — privacy/retention field
--> statement-breakpoint

ALTER TABLE "approvals"
  ADD COLUMN IF NOT EXISTS "artifact_kind" text,
  ADD COLUMN IF NOT EXISTS "artifact_pointer" text,
  ADD COLUMN IF NOT EXISTS "artifact_sha256" text,
  ADD COLUMN IF NOT EXISTS "redaction_state" text NOT NULL DEFAULT 'unredacted';

COMMENT ON COLUMN "approvals"."artifact_kind" IS
  'Kind of artifact associated with this approval (e.g. work_product). Set for publish_full_artifact type (JAC-4538).';
COMMENT ON COLUMN "approvals"."artifact_pointer" IS
  'Storage pointer or URL to the artifact content (JAC-4538).';
COMMENT ON COLUMN "approvals"."artifact_sha256" IS
  'SHA-256 hex digest of the artifact content for integrity verification (JAC-4538).';
COMMENT ON COLUMN "approvals"."redaction_state" IS
  'Privacy/retention field: unredacted, partially_redacted, or fully_redacted (JAC-4538).';
