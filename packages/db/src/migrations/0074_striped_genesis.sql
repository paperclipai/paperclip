CREATE UNIQUE INDEX "issues_active_productivity_review_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'issue_productivity_review'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');
