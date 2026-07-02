CREATE UNIQUE INDEX "issues_linear_origin_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'linear'
          and "issues"."origin_id" is not null;