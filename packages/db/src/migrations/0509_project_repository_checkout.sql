ALTER TABLE "projects" ADD COLUMN "repository_checkout" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_repository_checkout_check" CHECK ("projects"."repository_checkout" in ('all', 'primary', 'none')) NOT VALID;
