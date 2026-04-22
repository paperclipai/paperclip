CREATE TABLE "project_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "project_folders_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_project_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."project_folders"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "project_folders_company_idx" ON "project_folders" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "project_folders_company_sort_idx" ON "project_folders" USING btree ("company_id","sort_order");
--> statement-breakpoint
CREATE INDEX "projects_company_folder_idx" ON "projects" USING btree ("company_id","folder_id");
