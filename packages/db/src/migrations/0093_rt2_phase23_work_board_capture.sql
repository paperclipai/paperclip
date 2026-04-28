CREATE TABLE IF NOT EXISTS "rt2_work_board_cards" (
  "issue_id" uuid PRIMARY KEY REFERENCES "issues"("id") ON DELETE cascade,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "due_date" date,
  "quality_status" text DEFAULT 'none' NOT NULL,
  "price_gold" integer,
  "detail_notes" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_work_board_cards_company_due_idx"
  ON "rt2_work_board_cards" ("company_id", "due_date");
CREATE INDEX IF NOT EXISTS "rt2_work_board_cards_company_quality_idx"
  ON "rt2_work_board_cards" ("company_id", "quality_status");

CREATE TABLE IF NOT EXISTS "rt2_work_board_checklist_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "checked" integer DEFAULT 0 NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_work_board_checklist_issue_position_idx"
  ON "rt2_work_board_checklist_items" ("company_id", "issue_id", "position");

CREATE TABLE IF NOT EXISTS "rt2_work_board_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
  "label" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text,
  "preview_kind" text DEFAULT 'link' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_work_board_attachment_issue_position_idx"
  ON "rt2_work_board_attachments" ("company_id", "issue_id", "position");

CREATE TABLE IF NOT EXISTS "rt2_capture_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "channel" text,
  "external_user_id" text,
  "raw_text" text NOT NULL,
  "normalized_hash" text NOT NULL,
  "parsed_draft" jsonb NOT NULL,
  "status" text DEFAULT 'review_required' NOT NULL,
  "promotion_target" text,
  "promoted_issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "promoted_work_product_id" uuid,
  "duplicate_of_draft_id" uuid,
  "failure_code" text,
  "failure_message" text,
  "permission_status" text DEFAULT 'allowed' NOT NULL,
  "audit_trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_user_id" text,
  "reviewed_by_user_id" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_capture_drafts_company_source_status_idx"
  ON "rt2_capture_drafts" ("company_id", "source", "status");
CREATE INDEX IF NOT EXISTS "rt2_capture_drafts_company_created_idx"
  ON "rt2_capture_drafts" ("company_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "rt2_capture_drafts_duplicate_lookup_uq"
  ON "rt2_capture_drafts" ("company_id", "source", "channel", "external_user_id", "normalized_hash");
