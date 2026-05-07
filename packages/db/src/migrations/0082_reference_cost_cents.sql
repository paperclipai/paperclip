-- Track the pay-as-you-go reference cost independently of the actually-billed
-- cost, so subscription-billed runs (Z.AI Coding Plan, Claude Pro, etc.) can
-- be reported at their public API-price equivalent for management/gestão views
-- without double-counting in the actual ledger.
--
-- For billingType = 'api' the two columns are equal (actual == reference).
-- For billingType = 'subscription_included' costCents stays 0 (no money moved)
-- while referenceCostCents carries the computed pay-as-you-go figure.

ALTER TABLE "cost_events"
  ADD COLUMN "reference_cost_cents" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "agent_runtime_state"
  ADD COLUMN "total_reference_cost_cents" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill: for existing rows, assume reference == billed. For historical
-- subscription_included runs the reference will stay 0 (we don't have the
-- adapter-reported usage + pricing table in SQL), but new runs from this
-- migration onward will populate it correctly.
UPDATE "cost_events" SET "reference_cost_cents" = "cost_cents"
  WHERE "billing_type" <> 'subscription_included';
--> statement-breakpoint

UPDATE "agent_runtime_state" SET "total_reference_cost_cents" = "total_cost_cents";
