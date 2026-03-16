-- Add LLM provider columns to agents table
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS preferred_llm_provider_type TEXT,
ADD COLUMN IF NOT EXISTS preferred_llm_model_id TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_agents_preferred_llm_provider ON agents(preferred_llm_provider_type);
