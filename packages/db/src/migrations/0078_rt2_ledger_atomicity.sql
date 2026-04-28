-- Add leg column with CHECK constraint for valid values
ALTER TABLE "rt2_coin_ledger" ADD COLUMN "leg" text NOT NULL DEFAULT 'credit';
ALTER TABLE "rt2_coin_ledger" ADD CONSTRAINT "rt2_coin_ledger_leg_check" CHECK ("leg" IN ('debit', 'credit'));
--> statement-breakpoint

-- Add balance_after non-negativity CHECK constraint
ALTER TABLE "rt2_coin_ledger" ADD CONSTRAINT "rt2_coin_ledger_balance_non_neg_check" CHECK ("balance_after" >= 0);
--> statement-breakpoint

-- Backfill existing rows: amount >= 0 → credit, amount < 0 → debit
UPDATE "rt2_coin_ledger" SET "leg" = CASE WHEN "amount" >= 0 THEN 'credit' ELSE 'debit' END WHERE "leg" IS NULL;
--> statement-breakpoint

-- Add comment for documentation
COMMENT ON COLUMN "rt2_coin_ledger"."leg" IS 'Transaction leg: credit (balance increase) or debit (balance decrease)';
