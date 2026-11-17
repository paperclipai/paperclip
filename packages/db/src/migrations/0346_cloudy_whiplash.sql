-- Find an assignment's work wakes without scanning the company's dispatch history.
CREATE INDEX "grok_dispatch_assignment_kind_idx" ON "grok_bot_dispatches" USING btree ("assignment_id","kind");
