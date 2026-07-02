CREATE TABLE IF NOT EXISTS "work_cycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'planned' NOT NULL,
  "start_date" date,
  "end_date" date,
  "capacity_story_points" integer,
  "capacity_hours" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "work_cycles" ADD CONSTRAINT "work_cycles_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "work_cycles" ADD CONSTRAINT "work_cycles_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "cycle_id" uuid;

DO $$ BEGIN
  ALTER TABLE "issues" ADD CONSTRAINT "issues_cycle_id_work_cycles_id_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "public"."work_cycles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "work_cycles_company_project_status_idx" ON "work_cycles" USING btree ("company_id","project_id","status");
CREATE INDEX IF NOT EXISTS "work_cycles_company_dates_idx" ON "work_cycles" USING btree ("company_id","start_date","end_date");
CREATE INDEX IF NOT EXISTS "issues_company_cycle_idx" ON "issues" USING btree ("company_id","cycle_id");
