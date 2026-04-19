ALTER TABLE "project_quick_links" ADD COLUMN "site_name" text;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD COLUMN "favicon_url" text;--> statement-breakpoint
ALTER TABLE "project_quick_links" ADD COLUMN "metadata_fetched_at" timestamp with time zone;
