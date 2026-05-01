CREATE UNIQUE INDEX "issues_gmail_thread_triage_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'gmail_thread_triage'
          and "issues"."origin_id" is not null
          and "issues"."status" <> 'cancelled';