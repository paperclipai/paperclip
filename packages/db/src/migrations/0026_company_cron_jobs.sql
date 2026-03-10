CREATE TABLE "company_cron_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expr" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"stagger_ms" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_duration_ms" integer,
	"last_run_id" uuid,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_cron_jobs" ADD CONSTRAINT "company_cron_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_cron_jobs" ADD CONSTRAINT "company_cron_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_jobs_next_run_idx" ON "company_cron_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "cron_jobs_agent_idx" ON "company_cron_jobs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cron_jobs_company_idx" ON "company_cron_jobs" USING btree ("company_id");
