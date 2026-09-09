CREATE TABLE IF NOT EXISTS "journal_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "entry_date" text NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "mood_score" integer,
  "tags" text[] NOT NULL DEFAULT '{}',
  "is_private" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "journal_entries_user_company_idx" ON "journal_entries" ("user_id", "company_id");
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" ("company_id", "user_id", "entry_date");
