ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;