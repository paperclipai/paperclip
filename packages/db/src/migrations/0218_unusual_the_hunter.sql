ALTER TABLE "issue_execution_decisions" ADD COLUMN "review_round_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "payload_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_decisions_review_round_uq" ON "issue_execution_decisions" USING btree ("issue_id","review_round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_decisions_reviewer_run_idempotency_uq" ON "issue_execution_decisions" USING btree ("created_by_run_id","idempotency_key");