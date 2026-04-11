ALTER TABLE "companies"
ADD COLUMN "daily_executive_summary_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies"
ADD COLUMN "daily_executive_summary_last_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companies"
ADD COLUMN "daily_executive_summary_last_status" text;
--> statement-breakpoint
ALTER TABLE "companies"
ADD COLUMN "daily_executive_summary_last_error" text;
--> statement-breakpoint
ALTER TABLE "companies"
ADD CONSTRAINT "companies_daily_executive_summary_last_status_check"
CHECK ("companies"."daily_executive_summary_last_status" IN ('ok', 'failed', 'skipped'));
--> statement-breakpoint

CREATE TABLE "company_kpis" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "label" text NOT NULL,
  "value" text NOT NULL,
  "trend" text DEFAULT 'none' NOT NULL,
  "note" text,
  "position" integer NOT NULL,
  "updated_by_user_id" text,
  "updated_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_kpis_trend_check" CHECK ("company_kpis"."trend" IN ('up', 'down', 'flat', 'none'))
);
--> statement-breakpoint
ALTER TABLE "company_kpis"
ADD CONSTRAINT "company_kpis_company_id_companies_id_fk"
FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_kpis"
ADD CONSTRAINT "company_kpis_updated_by_user_id_user_id_fk"
FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_kpis"
ADD CONSTRAINT "company_kpis_updated_by_agent_id_agents_id_fk"
FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "company_kpis_company_idx" ON "company_kpis" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "company_kpis_company_updated_idx" ON "company_kpis" USING btree ("company_id","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_kpis_company_position_uq" ON "company_kpis" USING btree ("company_id","position");
