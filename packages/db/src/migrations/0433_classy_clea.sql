-- Preserve the previous workspace for existing people who never saved a
-- preference. New people have no row and receive the new application default.
INSERT INTO "user_workspace_preferences" ("user_id", "coordinator_workspace_enabled")
SELECT "id", false FROM "user"
UNION
SELECT "principal_id", false FROM "company_memberships" WHERE "principal_type" = 'user'
UNION
SELECT 'local-board', false WHERE EXISTS (SELECT 1 FROM "companies")
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ALTER COLUMN "coordinator_workspace_enabled" SET DEFAULT true;
