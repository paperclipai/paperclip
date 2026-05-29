-- Add circuit-breaker fields to agents table
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS consecutiveFailureCount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lastFailureFingerprint TEXT;
