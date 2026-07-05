CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "folders_company_kind_position_idx" ON "folders" USING btree ("company_id","kind","position","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "folders_company_kind_name_uq" ON "folders" USING btree ("company_id","kind","name");
--> statement-breakpoint
CREATE INDEX "company_skills_company_folder_idx" ON "company_skills" USING btree ("company_id","folder_id");
--> statement-breakpoint
CREATE INDEX "routines_company_folder_idx" ON "routines" USING btree ("company_id","folder_id");
