CREATE INDEX IF NOT EXISTS "case_handoffs_source_run_idx" ON "case_handoffs" USING btree ("company_id","source_run_id") WHERE "case_handoffs"."source_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_handoffs_wakeup_request_uq" ON "case_handoffs" USING btree ("wakeup_request_id");
