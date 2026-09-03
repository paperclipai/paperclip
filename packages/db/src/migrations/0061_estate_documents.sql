-- Estate Document Vault: estate_documents + estate_document_access_log tables
-- IUN-1657 deliverables

CREATE TYPE "estate_document_type" AS ENUM (
  'will', 'trust', 'deed', 'poa', 'healthcare_directive', 'insurance', 'other'
);

CREATE TYPE "estate_document_access_policy" AS ENUM (
  'owner_only', 'advisor_readable', 'beneficiary_event_triggered'
);

CREATE TYPE "estate_document_access_type" AS ENUM (
  'view', 'download', 'share_link'
);

CREATE TABLE IF NOT EXISTS "estate_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "estate_id" uuid NOT NULL REFERENCES "estates"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "uploader_user_id" text NOT NULL,
  "document_type" "estate_document_type" NOT NULL DEFAULT 'other',
  "title" text NOT NULL,
  "s3_key" text NOT NULL,
  "s3_bucket" text NOT NULL,
  "kms_key_id" text,
  "content_hash" text,
  "size_bytes" integer,
  "access_policy" "estate_document_access_policy" NOT NULL DEFAULT 'owner_only',
  "expires_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estate_documents_estate_idx" ON "estate_documents" ("estate_id");
CREATE INDEX "estate_documents_company_idx" ON "estate_documents" ("company_id");

CREATE TABLE IF NOT EXISTS "estate_document_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "estate_documents"("id") ON DELETE CASCADE,
  "accessor_user_id" text NOT NULL,
  "access_type" "estate_document_access_type" NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "accessed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "estate_document_access_log_document_idx" ON "estate_document_access_log" ("document_id");
