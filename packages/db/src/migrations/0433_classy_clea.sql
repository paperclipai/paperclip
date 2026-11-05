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
-- Chat is instance-wide. Retain its former default on existing installations,
-- without overwriting an explicit saved value or any other instance settings.
INSERT INTO "instance_settings" ("singleton_key", "experimental")
SELECT 'default', '{"enableAgentChat":false}'::jsonb
WHERE EXISTS (SELECT 1 FROM "user") OR EXISTS (SELECT 1 FROM "companies")
ON CONFLICT ("singleton_key") DO UPDATE
SET "experimental" = "instance_settings"."experimental" || EXCLUDED."experimental"
WHERE NOT ("instance_settings"."experimental" ? 'enableAgentChat');
--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ALTER COLUMN "coordinator_workspace_enabled" SET DEFAULT true;
