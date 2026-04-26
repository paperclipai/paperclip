ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "quarantine_hold" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_quarantine_hold_idx" ON "issues" USING btree ("company_id","quarantine_hold");
