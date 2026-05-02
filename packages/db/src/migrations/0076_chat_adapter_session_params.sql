-- Add a column for adapter-execute session continuity. When a chat session
-- routes through an AdapterExecuteProvider (e.g. claude-local using Claude
-- Pro CLI auth), the adapter returns sessionParams that resume the same
-- conversation on the next turn — we store them here.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS adapter_session_params jsonb;
