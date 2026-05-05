-- Canonicalize stranded_issue_recovery fingerprints before rebuilding the partial unique index.
UPDATE "issues"
SET "origin_fingerprint" = 'stranded_issue_recovery:' || "company_id"::text || ':' || "origin_id" || ':stranded_assigned_issue'
WHERE "origin_kind" = 'stranded_issue_recovery'
  AND "origin_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX "issues_active_stranded_issue_recovery_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_active_stranded_issue_recovery_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'stranded_issue_recovery'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');
