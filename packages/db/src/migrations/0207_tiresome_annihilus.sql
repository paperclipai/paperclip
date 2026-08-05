ALTER TABLE "decision_triage_events"
  DROP CONSTRAINT IF EXISTS "decision_triage_events_queue_id_decision_queues_id_fk";
--> statement-breakpoint
ALTER TABLE "decision_triage_events"
  ADD CONSTRAINT "decision_triage_events_queue_id_decision_queues_id_fk"
  FOREIGN KEY ("queue_id") REFERENCES "public"."decision_queues"("id")
  ON DELETE set null ON UPDATE no action;
