CREATE TABLE IF NOT EXISTS "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"key" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"source" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_company_created_at_idx" ON "memory_entries" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_company_project_idx" ON "memory_entries" USING btree ("company_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_company_key_idx" ON "memory_entries" USING btree ("company_id","key");
