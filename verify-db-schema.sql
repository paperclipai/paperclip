-- Phase 0 Database Schema Verification Script
-- Run this after Docker database starts to verify all tables exist

-- 1. Check core tables exist
\echo '=== Core Tables ==='
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'companies') as companies;
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'agents') as agents;
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'issues') as issues;
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'auth_users') as auth_users;

-- 2. Check agent_conversations table (for Phase 0 Task 4)
\echo '=== Agent Conversations Table ==='
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_conversations') as agent_conversations;

-- If agent_conversations doesn't exist, create it:
-- CREATE TABLE agent_conversations (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
--   company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
--   role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
--   content TEXT NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );
-- CREATE INDEX idx_agent_conversations_agent_id ON agent_conversations(agent_id);
-- CREATE INDEX idx_agent_conversations_company_id ON agent_conversations(company_id);
-- CREATE INDEX idx_agent_conversations_created_at ON agent_conversations(created_at DESC);

-- 3. Check LLM-related tables
\echo '=== LLM Tables ==='
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'llm_providers') as llm_providers;
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'llm_provider_models') as llm_provider_models;

-- 4. Count records (should be empty at start)
\echo '=== Initial Record Counts ==='
SELECT COUNT(*) as company_count FROM companies;
SELECT COUNT(*) as agent_count FROM agents;
SELECT COUNT(*) as issue_count FROM issues;
SELECT COUNT(*) as llm_provider_count FROM llm_providers;

-- 5. List all tables (for reference)
\echo '=== All Tables ==='
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

\echo 'Schema verification complete!'
