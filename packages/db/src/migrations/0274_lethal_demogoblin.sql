ALTER TABLE "agent_wakeup_requests" ADD COLUMN "attempt_reason" text;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "claim_deadline_at" timestamp with time zone;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. This partial index covers only deferred wake rows and is required for bounded oldest-first drain lookup; deploy large instances in a maintenance window.
CREATE INDEX "agent_wakeup_requests_company_agent_deferred_attempt_idx" ON "agent_wakeup_requests" USING btree ("company_id","agent_id","requested_at") WHERE "agent_wakeup_requests"."status" = 'deferred_issue_execution';
