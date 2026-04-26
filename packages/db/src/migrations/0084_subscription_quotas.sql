-- Migration: subscription_quotas table for Phase 0.5 Dispatcher quota tracking
-- Parent issue: KIT-3572 (Phase 0.5 — Dispatcher quota tracking)
-- Tracks subscription quota usage for dispatching decisions

CREATE TABLE IF NOT EXISTS subscription_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  used_messages integer NOT NULL DEFAULT 0,
  used_tokens integer NOT NULL DEFAULT 0,
  capacity_messages integer NOT NULL,
  capacity_tokens integer NOT NULL,
  last_updated timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_quotas_subscription ON subscription_quotas(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_quotas_window ON subscription_quotas(window_start, window_end);

CREATE TRIGGER update_subscription_quotas_last_updated
  BEFORE UPDATE ON subscription_quotas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
