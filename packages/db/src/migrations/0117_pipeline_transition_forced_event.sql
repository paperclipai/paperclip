-- Event-type constraint expansion is consolidated in 0121_pipeline_automation_retry_effects.sql.
-- Keep this journal entry as an idempotent placeholder for old branch-number upgrades.
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_0117_placeholder";
