ALTER TABLE "case_events" DROP CONSTRAINT IF EXISTS "case_events_kind_check";--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed',
        'handoff_requested',
        'handoff_applied',
        'handoff_delivered',
        'handoff_completed',
        'handoff_cancelled'
      ));
