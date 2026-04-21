ALTER TABLE "companies" ADD COLUMN "default_root_issue_delivery_mode" text DEFAULT 'engineering' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_root_issue_delivery_mode" text DEFAULT 'inherit' NOT NULL;
