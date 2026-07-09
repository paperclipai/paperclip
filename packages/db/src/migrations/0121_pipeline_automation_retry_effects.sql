ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "automation_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_by_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "retired_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "hidden_from_board_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "automation_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_by_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "retired_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "retry_of_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "pipeline_cases_parent_request_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_parent_request_key_uq" ON "pipeline_cases" USING btree ("parent_case_id","request_key") WHERE "pipeline_cases"."request_key" is not null and "pipeline_cases"."retired_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_automation_attempt_idx" ON "pipeline_cases" USING btree ("automation_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_retired_idx" ON "pipeline_cases" USING btree ("company_id","retired_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_automation_attempt_idx" ON "pipeline_case_issue_links" USING btree ("automation_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_retry_of_execution_idx" ON "pipeline_automation_executions" USING btree ("retry_of_execution_id");--> statement-breakpoint
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_type_check";--> statement-breakpoint
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
