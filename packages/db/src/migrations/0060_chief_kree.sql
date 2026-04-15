CREATE TABLE "board_brief_alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"incident_type" text NOT NULL,
	"severity" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"first_sent_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"last_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_brief_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"health" text NOT NULL,
	"confidence" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"related_alert_event_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "critical_board_alerts_email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "board_brief_alert_events" ADD CONSTRAINT "board_brief_alert_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_brief_snapshots" ADD CONSTRAINT "board_brief_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_brief_alert_events_company_fingerprint_uq" ON "board_brief_alert_events" USING btree ("company_id","fingerprint");--> statement-breakpoint
CREATE INDEX "board_brief_alert_events_company_status_severity_updated_idx" ON "board_brief_alert_events" USING btree ("company_id","status","severity","updated_at");--> statement-breakpoint
CREATE INDEX "board_brief_snapshots_company_generated_idx" ON "board_brief_snapshots" USING btree ("company_id","generated_at");--> statement-breakpoint
CREATE INDEX "board_brief_snapshots_company_source_generated_idx" ON "board_brief_snapshots" USING btree ("company_id","source","generated_at");