-- Add timeout/escalation support to request_confirmation interactions.
-- When an interaction is created with timeoutMinutes set, scheduled_escalation_at
-- is populated and a background job auto-accepts the interaction when the deadline passes.

ALTER TABLE "issue_thread_interactions"
  ADD COLUMN "scheduled_escalation_at" timestamp with time zone;

CREATE INDEX "issue_thread_interactions_scheduled_escalation_idx"
  ON "issue_thread_interactions" ("scheduled_escalation_at");
