CREATE TABLE IF NOT EXISTS "folders" (
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
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "folder_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'folders_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'company_skills_folder_id_folders_id_fk'
	) THEN
		ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'routines_folder_id_folders_id_fk'
	) THEN
		ALTER TABLE "routines" ADD CONSTRAINT "routines_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_company_kind_position_idx" ON "folders" USING btree ("company_id","kind","position","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_name_uq" ON "folders" USING btree ("company_id","kind","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_folder_idx" ON "company_skills" USING btree ("company_id","folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_folder_idx" ON "routines" USING btree ("company_id","folder_id");
