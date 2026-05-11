-- ADR-001 D3: companies quota-driven auto-pause columns.
-- Distinct from existing `pause_reason`/`paused_at` (manual/budget pause, set by
-- server/src/services/budgets.ts). These three are set together in a transaction by the
-- claude_local adapter when a `claude_quota_exhausted` run happens, and cleared after
-- the canary re-entry (P-2). NULL = company not auto-paused (default behavior).
ALTER TABLE "companies" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "paused_canary_at" timestamp with time zone;
