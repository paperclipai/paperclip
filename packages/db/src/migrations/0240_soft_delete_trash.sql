ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agents_company_deleted_idx" ON "agents" ("company_id") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "goals_company_deleted_idx" ON "goals" ("company_id") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_company_deleted_idx" ON "projects" ("company_id") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "issues_company_deleted_idx" ON "issues" ("company_id") WHERE "hidden_at" IS NOT NULL;
