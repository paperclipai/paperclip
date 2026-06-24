DROP INDEX IF EXISTS "issues_company_evidence_verdict_evaluated_idx";--> statement-breakpoint
CREATE INDEX "issues_company_evidence_verdict_evaluated_idx" ON "issues" USING btree ("company_id","last_evidence_verdict_evaluated_at") WHERE "last_evidence_verdict" IS NOT NULL;
