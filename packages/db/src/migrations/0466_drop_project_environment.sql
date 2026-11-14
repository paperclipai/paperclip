ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_environment_id_environments_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "environment_id";
