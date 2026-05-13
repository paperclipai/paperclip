-- 0086_broker_targets.sql
--
-- Additive: adds a `broker_targets` jsonb column to `oauth_connections`
-- for BYO credential-broker push targets. See the credential broker
-- design spec §5.3 (docs/superpowers/specs/2026-05-12-credential-broker-design.md).
--
-- Each element is an object: { id: string, url: string,
-- authTokenSecretId: string, addedAt: string }. The shape is enforced
-- at the array level by a CHECK constraint; deeper validation lives
-- in the broker-targets service (T5).
--
-- Idempotent: re-applying is a no-op (matches the convention from
-- 0085_oauth_connections.sql).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oauth_connections' AND column_name = 'broker_targets'
  ) THEN
    ALTER TABLE "oauth_connections"
      ADD COLUMN "broker_targets" jsonb DEFAULT '[]'::jsonb NOT NULL;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_connections_broker_targets_shape'
  ) THEN
    ALTER TABLE "oauth_connections"
      ADD CONSTRAINT "oauth_connections_broker_targets_shape"
      CHECK (jsonb_typeof("broker_targets") = 'array');
  END IF;
END $$;
