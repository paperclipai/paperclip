ALTER TABLE "projects" ADD COLUMN "parent_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_id_projects_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "projects_company_parent_idx" ON "projects" USING btree ("company_id","parent_id");
