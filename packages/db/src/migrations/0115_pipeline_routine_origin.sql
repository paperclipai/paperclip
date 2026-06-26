ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_type_check";--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_origin_idx" ON "routines" USING btree ("company_id","origin_kind","origin_id");--> statement-breakpoint
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
