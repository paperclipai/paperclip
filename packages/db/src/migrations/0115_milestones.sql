CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"target_date" date,
	"sort_order" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade,
	CONSTRAINT "milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX "milestones_company_idx" ON "milestones" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "milestones_company_project_idx" ON "milestones" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "issues_company_milestone_idx" ON "issues" USING btree ("company_id","milestone_id") WHERE (milestone_id IS NOT NULL);
