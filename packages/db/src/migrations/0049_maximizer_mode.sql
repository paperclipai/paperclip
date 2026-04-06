-- Migration: 0049_maximizer_mode
-- Description: Add MAXIMIZER MODE columns to heartbeat_runs and agents tables
-- Date: 2026-04-02

-- Heartbeat run control columns
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ;
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS interrupt_message TEXT;
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS interrupt_mode TEXT;
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS circuit_breaker_tripped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE heartbeat_runs ADD COLUMN IF NOT EXISTS circuit_breaker_reason TEXT;

-- Agent maximizer configuration columns
ALTER TABLE agents ADD COLUMN IF NOT EXISTS maximizer_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS maximizer_max_consecutive_failures INTEGER NOT NULL DEFAULT 3;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS maximizer_max_runs_without_progress INTEGER NOT NULL DEFAULT 5;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS maximizer_token_velocity_limit INTEGER;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS maximizer_auto_approve BOOLEAN NOT NULL DEFAULT false;
