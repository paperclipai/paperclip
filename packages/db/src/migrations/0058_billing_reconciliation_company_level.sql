-- Switch billing_reconciliation from per-agent to company-level rows.
-- agent_id becomes nullable (null = org-level row) and the unique index
-- moves from (date, agent_id) to (date, company_id).
ALTER TABLE "billing_reconciliation" DROP CONSTRAINT IF EXISTS "billing_reconciliation_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "billing_reconciliation" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "billing_reconciliation_date_agent_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_reconciliation_date_company_uq" ON "billing_reconciliation" USING btree ("date","company_id");
