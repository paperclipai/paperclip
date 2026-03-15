CREATE TABLE "cron_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"issue_mode" text DEFAULT 'create_new' NOT NULL,
	"issue_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"next_trigger_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_schedules" ADD CONSTRAINT "cron_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_schedules" ADD CONSTRAINT "cron_schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_schedules" ADD CONSTRAINT "cron_schedules_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_schedules_company_enabled_next_idx" ON "cron_schedules" USING btree ("company_id","enabled","next_trigger_at");--> statement-breakpoint
CREATE INDEX "cron_schedules_agent_enabled_next_idx" ON "cron_schedules" USING btree ("agent_id","enabled","next_trigger_at");--> statement-breakpoint
CREATE INDEX "cron_schedules_issue_idx" ON "cron_schedules" USING btree ("issue_id");