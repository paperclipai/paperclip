-- JAC-4530: Add cost metadata and native/recomputed total token columns to run_events.
-- These fields enable distinguishing how cost was determined, confidence in cost
-- accuracy, native provider totals vs recomputed estimates, and subscription status.

ALTER TABLE "run_events"
  ADD COLUMN IF NOT EXISTS "price_basis" text NOT NULL DEFAULT 'not_reported',
  ADD COLUMN IF NOT EXISTS "cost_confidence" text NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS "pricing_version_ref" text,
  ADD COLUMN IF NOT EXISTS "native_total_tokens" integer,
  ADD COLUMN IF NOT EXISTS "recomputed_total_tokens" integer,
  ADD COLUMN IF NOT EXISTS "is_subscription_included" boolean NOT NULL DEFAULT false;--> statement-breakpoint
COMMENT ON COLUMN "run_events"."price_basis" IS
  'How the cost was determined (JAC-4530): per_1m_tokens, plan_billed, estimated, not_reported, unknown. Defaults to not_reported.';--> statement-breakpoint
COMMENT ON COLUMN "run_events"."cost_confidence" IS
  'Confidence in cost accuracy (JAC-4530): high, medium, low, unknown. Distinct from generic confidence field.';--> statement-breakpoint
COMMENT ON COLUMN "run_events"."pricing_version_ref" IS
  'Pointer to the pricing-version record used for cost computation.';--> statement-breakpoint
COMMENT ON COLUMN "run_events"."native_total_tokens" IS
  'Provider native total token count (e.g. OpenAI usage.total_tokens). Kept separate from recomputed estimates.';--> statement-breakpoint
COMMENT ON COLUMN "run_events"."recomputed_total_tokens" IS
  'Recomputed total = input + output + cached + reasoning + tool_call tokens.';--> statement-breakpoint
COMMENT ON COLUMN "run_events"."is_subscription_included" IS
  'Whether usage is covered by a subscription rather than per-token metering.';
