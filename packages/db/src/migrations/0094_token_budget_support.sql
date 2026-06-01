-- Add budgetMonthlyTokens field to agents table for token-based budgeting (MVA-2036)
ALTER TABLE "agents" ADD COLUMN "budget_monthly_tokens" integer NOT NULL DEFAULT 0;
