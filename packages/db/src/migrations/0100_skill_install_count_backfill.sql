UPDATE "company_skills" SET "install_count" = 0 WHERE "install_count" IS NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ALTER COLUMN "install_count" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_skills" ALTER COLUMN "install_count" SET NOT NULL;
