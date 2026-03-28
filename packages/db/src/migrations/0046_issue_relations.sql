CREATE TABLE IF NOT EXISTS "issue_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "related_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "issue_relations_issue_idx" ON "issue_relations" ("company_id", "issue_id");
CREATE INDEX IF NOT EXISTS "issue_relations_related_idx" ON "issue_relations" ("company_id", "related_issue_id");
