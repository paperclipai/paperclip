CREATE TABLE IF NOT EXISTS "rt2_capture_draft_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "rt2_capture_drafts"("id") ON DELETE cascade,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "revision_number" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "change_summary" text,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_capture_draft_revisions_draft_revision_uq"
  ON "rt2_capture_draft_revisions" ("draft_id", "revision_number");

CREATE INDEX IF NOT EXISTS "rt2_capture_draft_revisions_company_draft_idx"
  ON "rt2_capture_draft_revisions" ("company_id", "draft_id");
