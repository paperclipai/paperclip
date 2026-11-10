ALTER TABLE "projects" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "projects" p
SET "environment_id" = e."id", "execution_workspace_policy" = p."execution_workspace_policy" - 'environmentId'
FROM "environments" e
WHERE lower(p."execution_workspace_policy" ->> 'environmentId') = e."id"::text;
