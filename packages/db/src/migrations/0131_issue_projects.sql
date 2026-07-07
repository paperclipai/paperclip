CREATE TABLE IF NOT EXISTS "issue_projects" (
  "issue_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_projects_pk" PRIMARY KEY("issue_id","project_id"),
  CONSTRAINT "issue_projects_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "issue_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "issue_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_projects_one_primary_uq"
  ON "issue_projects" USING btree ("issue_id")
  WHERE "is_primary" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_projects_company_project_idx"
  ON "issue_projects" USING btree ("company_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_projects_project_idx"
  ON "issue_projects" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_projects_issue_idx"
  ON "issue_projects" USING btree ("issue_id");
--> statement-breakpoint
INSERT INTO "issue_projects" ("issue_id", "project_id", "company_id", "is_primary")
SELECT "id", "project_id", "company_id", true
FROM "issues"
WHERE "project_id" IS NOT NULL
ON CONFLICT ("issue_id", "project_id") DO NOTHING;
