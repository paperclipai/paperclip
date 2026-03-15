DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'company_skills'
	) THEN
		CREATE TABLE "company_skills" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"company_id" uuid NOT NULL,
			"slug" text NOT NULL,
			"name" text NOT NULL,
			"description" text,
			"markdown" text NOT NULL,
			"source_type" text DEFAULT 'local_path' NOT NULL,
			"source_locator" text,
			"source_ref" text,
			"trust_level" text DEFAULT 'markdown_only' NOT NULL,
			"compatibility" text DEFAULT 'compatible' NOT NULL,
			"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
			"metadata" jsonb,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL,
			"updated_at" timestamp with time zone DEFAULT now() NOT NULL
		);
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'company_skills_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "company_skills"
		ADD CONSTRAINT "company_skills_company_id_companies_id_fk"
		FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
		ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skills_company_slug_idx" ON "company_skills" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_name_idx" ON "company_skills" USING btree ("company_id","name");
