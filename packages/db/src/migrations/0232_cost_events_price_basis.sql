-- JAC-4530: Add price_basis and cost_confidence columns to cost_events.
-- These fields distinguish how cost was determined (per-token metering vs
-- subscription vs estimated) and provide a cost-specific confidence level
-- separate from the generic coverage `confidence` field.
-- Fail-closed defaults: price_basis = 'not_reported', cost_confidence = 'low'.

ALTER TABLE "cost_events"
  ADD COLUMN IF NOT EXISTS "price_basis" text NOT NULL DEFAULT 'not_reported',
  ADD COLUMN IF NOT EXISTS "cost_confidence" text NOT NULL DEFAULT 'low';--> statement-breakpoint
COMMENT ON COLUMN "cost_events"."price_basis" IS
  'How the cost was determined (JAC-4530): per_1m_tokens, plan_billed, estimated, not_reported, unknown. Defaults to not_reported (fail-closed when cost data is absent).';--> statement-breakpoint
COMMENT ON COLUMN "cost_events"."cost_confidence" IS
  'Confidence in cost accuracy (JAC-4530): high, medium, low, unknown. Distinct from generic confidence field which covers overall data confidence.';
