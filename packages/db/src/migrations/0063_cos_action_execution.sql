-- Phase 4 prep: action execution audit trail + result/error capture.
--
-- Adds columns to room_messages so action transitions record who executed
-- them, when, and with what result or error message. Enables true
-- idempotency (re-applying the same terminal state returns the stored row)
-- and unblocks the CLI-side action executor in Phase 4.

ALTER TABLE "room_messages"
  ADD COLUMN "action_result" jsonb,
  ADD COLUMN "action_error" text,
  ADD COLUMN "action_executed_at" timestamp with time zone,
  ADD COLUMN "action_executed_by_agent_id" uuid,
  ADD COLUMN "action_executed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "room_messages"
  ADD CONSTRAINT "room_messages_action_executed_by_agent_id_agents_id_fk"
  FOREIGN KEY ("action_executed_by_agent_id")
  REFERENCES "public"."agents"("id")
  ON DELETE set null ON UPDATE no action;
