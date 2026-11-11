-- Drop the project-owned run environment. A project owns its workspace
-- storage, chosen once at creation; runs follow the agent, then the instance
-- default. The column lost its last reader when project placement was removed.
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_environment_id_environments_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "environment_id";
