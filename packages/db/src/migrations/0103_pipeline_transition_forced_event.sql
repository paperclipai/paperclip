ALTER TABLE "pipeline_case_events" DROP CONSTRAINT "pipeline_case_events_type_check";--> statement-breakpoint
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
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift'
      ));
