CREATE TABLE "responsibility_metric_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	"value" numeric NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_agent_id" uuid,
	"recorded_by_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"display" text NOT NULL,
	"unit" text,
	"target" numeric,
	"direction" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibility_metrics_display_check" CHECK ("responsibility_metrics"."display" in ('number', 'percent', 'line', 'bar')),
	CONSTRAINT "responsibility_metrics_direction_check" CHECK ("responsibility_metrics"."direction" is null or "responsibility_metrics"."direction" in ('at_least', 'at_most')),
	CONSTRAINT "responsibility_metrics_status_check" CHECK ("responsibility_metrics"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "responsibility_status_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibility_status_reports_status_check" CHECK ("responsibility_status_reports"."status" in ('behind', 'at_risk', 'on_track', 'unknown')),
	CONSTRAINT "responsibility_status_reports_author_check" CHECK (not ("responsibility_status_reports"."agent_id" is not null and "responsibility_status_reports"."user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "responsibility_metric_readings" ADD CONSTRAINT "responsibility_metric_readings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_metric_readings" ADD CONSTRAINT "responsibility_metric_readings_metric_id_responsibility_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."responsibility_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_metric_readings" ADD CONSTRAINT "responsibility_metric_readings_recorded_by_agent_id_agents_id_fk" FOREIGN KEY ("recorded_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_metrics" ADD CONSTRAINT "responsibility_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_metrics" ADD CONSTRAINT "responsibility_metrics_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_metrics" ADD CONSTRAINT "responsibility_metrics_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_status_reports" ADD CONSTRAINT "responsibility_status_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_status_reports" ADD CONSTRAINT "responsibility_status_reports_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_status_reports" ADD CONSTRAINT "responsibility_status_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibility_metric_readings_metric_recorded_idx" ON "responsibility_metric_readings" USING btree ("metric_id","recorded_at");--> statement-breakpoint
CREATE INDEX "responsibility_metrics_responsibility_status_position_idx" ON "responsibility_metrics" USING btree ("responsibility_id","status","position");--> statement-breakpoint
CREATE INDEX "responsibility_status_reports_responsibility_created_idx" ON "responsibility_status_reports" USING btree ("responsibility_id","created_at" DESC NULLS LAST);