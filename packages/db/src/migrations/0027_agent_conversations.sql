-- Create agent_conversations table for chat history
CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_id
  ON agent_conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_created_at
  ON agent_conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_created
  ON agent_conversations(agent_id, created_at DESC);
