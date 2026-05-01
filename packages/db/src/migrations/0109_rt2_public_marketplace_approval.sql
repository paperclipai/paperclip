-- Phase 72: Public Marketplace Launch
-- Add approval workflow columns to rt2_agent_marketplace

ALTER TABLE "rt2_agent_marketplace" ADD COLUMN IF NOT EXISTS "listing_approval_status" text NOT NULL DEFAULT 'draft';
ALTER TABLE "rt2_agent_marketplace" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
ALTER TABLE "rt2_agent_marketplace" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
ALTER TABLE "rt2_agent_marketplace" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "agent_marketplace_approval_status_idx"
  ON "rt2_agent_marketplace" ("listing_approval_status");
