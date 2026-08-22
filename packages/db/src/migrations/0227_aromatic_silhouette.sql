CREATE TABLE "pipeline_case_case_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"linked_case_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT "pipeline_case_events_type_check";--> statement-breakpoint
ALTER TABLE "pipeline_case_case_links" ADD CONSTRAINT "pipeline_case_case_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_case_links" ADD CONSTRAINT "pipeline_case_case_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_case_links" ADD CONSTRAINT "pipeline_case_case_links_linked_case_id_cases_id_fk" FOREIGN KEY ("linked_case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_case_links_case_link_uq" ON "pipeline_case_case_links" USING btree ("case_id","linked_case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_case_links_linked_case_idx" ON "pipeline_case_case_links" USING btree ("linked_case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_case_links_company_case_idx" ON "pipeline_case_case_links" USING btree ("company_id","case_id");--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'case_linked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      ));