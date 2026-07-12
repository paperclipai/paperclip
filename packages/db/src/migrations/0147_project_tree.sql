ALTER TABLE "projects" ADD COLUMN "parent_project_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_project_id_projects_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_not_self" CHECK ("parent_project_id" IS NULL OR "parent_project_id" <> "id");
--> statement-breakpoint
CREATE INDEX "projects_company_parent_idx" ON "projects" USING btree ("company_id", "parent_project_id");
