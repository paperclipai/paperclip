-- Replayed upgrades must also accept rows already using terminal handoffs.
ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_destination_check";
--> statement-breakpoint
ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_destination_state_check";
--> statement-breakpoint
ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_state_check";--> statement-breakpoint
DROP INDEX IF EXISTS "case_handoffs_pending_case_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "case_handoffs_pending_issue_uq";--> statement-breakpoint
ALTER TABLE "case_handoffs" ALTER COLUMN "to_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN IF NOT EXISTS "destination_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "case_handoffs_pending_case_uq" ON "case_handoffs" USING btree ("case_id") WHERE "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch', 'awaiting_completion');--> statement-breakpoint
CREATE UNIQUE INDEX "case_handoffs_pending_issue_uq" ON "case_handoffs" USING btree ("issue_id") WHERE "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch', 'awaiting_completion');--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_destination_check" CHECK (("case_handoffs"."destination_kind" = 'agent' and "case_handoffs"."to_agent_id" is not null) or ("case_handoffs"."destination_kind" = 'done' and "case_handoffs"."to_agent_id" is null));--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_destination_state_check" CHECK (("case_handoffs"."destination_kind" = 'agent' and "case_handoffs"."state" in ('awaiting_release', 'pending_dispatch', 'delivered', 'cancelled')) or ("case_handoffs"."destination_kind" = 'done' and "case_handoffs"."state" in ('awaiting_completion', 'completed', 'cancelled')));--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_state_check" CHECK ("case_handoffs"."state" in ('awaiting_release', 'pending_dispatch', 'delivered', 'awaiting_completion', 'completed', 'cancelled'));
