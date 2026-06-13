ALTER TABLE "issues" ADD COLUMN "last_evidence_verdict_evaluated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "issues"
SET "last_evidence_verdict_evaluated_at" = ("last_evidence_verdict" ->> 'evaluatedAt')::timestamp with time zone
WHERE "last_evidence_verdict" ? 'evaluatedAt'
  AND ("last_evidence_verdict" ->> 'evaluatedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$';--> statement-breakpoint
CREATE INDEX "issues_company_evidence_verdict_evaluated_idx" ON "issues" USING btree ("company_id", "last_evidence_verdict_evaluated_at");
