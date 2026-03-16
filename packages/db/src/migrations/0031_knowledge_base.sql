-- Knowledge Base + Memory system
-- Enables agents to learn from documents and remember context

-- Documents table
CREATE TABLE knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT,
  file_size INTEGER,
  original_path TEXT,
  status TEXT NOT NULL DEFAULT 'processing', -- processing, ready, error
  error_message TEXT,
  chunk_count INTEGER DEFAULT 0,
  embedding_model TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  INDEX knowledge_documents_company_idx (company_id),
  INDEX knowledge_documents_agent_idx (agent_id),
  INDEX knowledge_documents_status_idx (status)
);

-- Document chunks (semantic paragraphs)
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER,
  embedding VECTOR(1536),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX knowledge_chunks_document_idx (document_id, chunk_index),
  INDEX knowledge_chunks_embedding_idx USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
);

-- Agent memory (learned facts, preferences, insights)
CREATE TABLE agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL, -- conversation, learned_fact, preference, insight
  content JSONB NOT NULL,
  relevance_score FLOAT DEFAULT 1.0,
  last_accessed TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX agent_memory_agent_idx (agent_id),
  INDEX agent_memory_type_idx (agent_id, memory_type),
  INDEX agent_memory_accessed_idx (agent_id, last_accessed DESC)
);

-- Conversation history (for context window management)
CREATE TABLE conversation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- user, assistant
  content TEXT NOT NULL,
  tokens INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX conversation_history_agent_idx (agent_id, created_at DESC),
  INDEX conversation_history_created_idx (created_at DESC)
);

-- Conversation summaries (for memory management)
CREATE TABLE conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  summary_type TEXT, -- periodic, long_term, learning
  summary_text TEXT NOT NULL,
  covered_from_id UUID REFERENCES conversation_history(id),
  covered_to_id UUID REFERENCES conversation_history(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX conversation_summaries_agent_idx (agent_id, created_at DESC)
);

-- Document-Agent associations (for knowledge sharing)
CREATE TABLE agent_knowledge_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  association_type TEXT, -- primary, secondary, reference
  custom_relevance FLOAT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX agent_knowledge_agent_idx (agent_id),
  INDEX agent_knowledge_document_idx (document_id),
  UNIQUE(agent_id, document_id)
);
