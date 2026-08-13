CREATE TABLE "workflow_run_telemetry_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"sequence" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_name" text,
	"operation_kind" text NOT NULL,
	"operation_name" text NOT NULL,
	"status" text,
	"input" jsonb,
	"output" jsonb,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_telemetry_events_run_event_id_unique" UNIQUE("workflow_run_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_run_telemetry_events" ADD CONSTRAINT "workflow_run_telemetry_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_telemetry_events" ADD CONSTRAINT "workflow_run_telemetry_events_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_run_telemetry_events_run_sequence_idx" ON "workflow_run_telemetry_events" USING btree ("workflow_run_id","sequence");--> statement-breakpoint
CREATE INDEX "workflow_run_telemetry_events_run_span_idx" ON "workflow_run_telemetry_events" USING btree ("workflow_run_id","span_id");--> statement-breakpoint
CREATE INDEX "workflow_run_telemetry_events_company_created_idx" ON "workflow_run_telemetry_events" USING btree ("company_id","created_at");
