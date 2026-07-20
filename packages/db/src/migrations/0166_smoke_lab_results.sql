CREATE TABLE IF NOT EXISTS "smoke_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smoke_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "path" text NOT NULL,
  "scenario_step" text NOT NULL,
  "status" text NOT NULL,
  "detail" text,
  "screenshot_artifact_ref" jsonb,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "smoke_runs" ADD CONSTRAINT "smoke_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_run_id_smoke_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."smoke_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_runs_company_started_idx" ON "smoke_runs" USING btree ("company_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_runs_company_status_idx" ON "smoke_runs" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_run_steps_company_run_idx" ON "smoke_run_steps" USING btree ("company_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_run_steps_company_path_idx" ON "smoke_run_steps" USING btree ("company_id", "path");
