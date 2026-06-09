ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT "workspace_operations_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;