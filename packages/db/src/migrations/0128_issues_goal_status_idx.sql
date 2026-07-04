CREATE INDEX "issues_company_goal_status_idx" ON "issues" USING btree ("company_id","goal_id","status");
