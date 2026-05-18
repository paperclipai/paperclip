-- Phase 4A-S4 B2 (LET-367): sandbox billing-cap counters + audit events.
--
-- Additive only: two new tables. No backfill required. Apply gated on Andrii
-- approval — LET-367 ships the migration file but does NOT apply it to prod.
CREATE TABLE IF NOT EXISTS "sandbox_billing_cap_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "day_window_start" timestamptz NOT NULL,
  "day_spent_cents" integer NOT NULL DEFAULT 0,
  "day_hard_cap_breached_at" timestamptz,
  "month_window_start" timestamptz NOT NULL,
  "month_spent_cents" integer NOT NULL DEFAULT 0,
  "month_hard_cap_breached_at" timestamptz,
  "provider_enable_layer_enabled" boolean NOT NULL DEFAULT true,
  "provider_enable_reason" text,
  "provider_enable_actor_label" text,
  "provider_enable_transition_at" timestamptz,
  "operator_toggle_enabled" boolean NOT NULL DEFAULT true,
  "operator_toggle_reason" text,
  "operator_toggle_actor_label" text,
  "operator_toggle_transition_at" timestamptz,
  "last_polled_at" timestamptz,
  "last_source" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_billing_cap_state_company_provider_uniq"
  ON "sandbox_billing_cap_state" ("company_id", "provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_billing_cap_state_company_idx"
  ON "sandbox_billing_cap_state" ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sandbox_billing_cap_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "kind" text NOT NULL,
  "window_kind" text,
  "spent_cents" integer,
  "threshold_cents" integer,
  "projection_cents" integer,
  "actor_label" text NOT NULL,
  "reason" text,
  "incident_issue_id" uuid,
  "metadata" jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_billing_cap_events_company_occurred_idx"
  ON "sandbox_billing_cap_events" ("company_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_billing_cap_events_company_kind_occurred_idx"
  ON "sandbox_billing_cap_events" ("company_id", "kind", "occurred_at");
