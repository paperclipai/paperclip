ALTER TABLE agents
ADD COLUMN IF NOT EXISTS consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_failure_fingerprint TEXT;
