CREATE TABLE "issue_delivery_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "source_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "producer_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "primary_work_product_key" text NOT NULL,
  "revision" text NOT NULL,
  "format" text NOT NULL,
  "summary" text NOT NULL,
  "inline_text" text,
  "inspection_url" text,
  "document_only" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "issues" ADD COLUMN "delivery_receipt_recovery_opened_at" timestamp with time zone;
CREATE INDEX "issue_delivery_receipts_source_lookup_idx" ON "issue_delivery_receipts" ("company_id", "source_issue_id");
CREATE UNIQUE INDEX "issue_delivery_receipts_identity_uq" ON "issue_delivery_receipts" ("company_id", "source_issue_id", "primary_work_product_key", "revision");
