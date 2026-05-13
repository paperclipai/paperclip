ALTER TABLE "issues" ADD COLUMN "visibility" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_collaborators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "reason" text DEFAULT 'explicit' NOT NULL,
  "added_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "added_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_collaborators_issue_principal_uq"
  ON "issue_collaborators" ("issue_id", "principal_type", "principal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_collaborators_company_issue_idx"
  ON "issue_collaborators" ("company_id", "issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_collaborators_principal_idx"
  ON "issue_collaborators" ("principal_type", "principal_id");
--> statement-breakpoint
INSERT INTO "issue_collaborators" ("company_id", "issue_id", "principal_type", "principal_id", "reason")
SELECT "company_id", "id", 'user', "created_by_user_id", 'creator'
FROM "issues"
WHERE "created_by_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "issue_collaborators" ("company_id", "issue_id", "principal_type", "principal_id", "reason")
SELECT "company_id", "id", 'user', "assignee_user_id", 'assignment'
FROM "issues"
WHERE "assignee_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "issue_collaborators" ("company_id", "issue_id", "principal_type", "principal_id", "reason")
SELECT "company_id", "id", 'agent', "assignee_agent_id"::text, 'assignment'
FROM "issues"
WHERE "assignee_agent_id" IS NOT NULL
ON CONFLICT DO NOTHING;
