-- MCP (Model Context Protocol) + External APIs System
-- Enables integration with MCPs and external APIs like GitHub, Linear, etc.

-- MCP Server configurations
CREATE TABLE mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'mcp', 'external_api'
  protocol TEXT,  -- 'stdio', 'sse', 'http'
  command TEXT,   -- For stdio servers: the command to run
  url TEXT,       -- For HTTP/SSE servers: the endpoint URL
  environment JSONB,  -- Environment variables for the server
  configuration JSONB NOT NULL,  -- Server-specific configuration
  enabled BOOLEAN DEFAULT true,
  error_message TEXT,
  last_health_check TIMESTAMP WITH TIME ZONE,
  health_status TEXT, -- 'healthy', 'unhealthy', 'unknown'
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX mcp_servers_company_idx (company_id),
  INDEX mcp_servers_type_idx (type),
  INDEX mcp_servers_enabled_idx (enabled)
);

-- External API Integrations (GitHub, Linear, etc.)
CREATE TABLE external_api_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'github', 'linear', 'jira', 'slack', 'notion', custom names
  name TEXT NOT NULL,
  api_endpoint TEXT NOT NULL,
  authentication_type TEXT NOT NULL, -- 'oauth', 'api_key', 'bearer_token', 'basic'
  credentials JSONB NOT NULL,  -- Encrypted API key, token, etc.
  scope TEXT[], -- Permissions/scopes for OAuth
  rate_limit INTEGER,  -- Requests per minute
  timeout_seconds INTEGER DEFAULT 30,
  retry_policy JSONB,  -- Retry configuration
  enabled BOOLEAN DEFAULT true,
  error_message TEXT,
  last_tested_at TIMESTAMP WITH TIME ZONE,
  test_status TEXT, -- 'success', 'failed', 'never_tested'
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX external_api_integrations_company_idx (company_id),
  INDEX external_api_integrations_provider_idx (provider)
);

-- API Request/Response logs
CREATE TABLE api_request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES external_api_integrations(id) ON DELETE CASCADE,
  agent_id UUID,
  method TEXT NOT NULL,  -- GET, POST, PUT, DELETE, etc.
  endpoint TEXT NOT NULL,
  status_code INTEGER,
  request_body JSONB,
  response_body JSONB,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX api_request_logs_integration_idx (integration_id),
  INDEX api_request_logs_agent_idx (agent_id),
  INDEX api_request_logs_created_idx (created_at)
);

-- Custom Adapters (for extending MCP/API functionality)
CREATE TABLE custom_adapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  adapter_type TEXT NOT NULL, -- 'tool', 'resource', 'transformer'
  source_code TEXT NOT NULL,  -- The adapter implementation
  language TEXT DEFAULT 'javascript',  -- javascript, python
  is_enabled BOOLEAN DEFAULT true,
  version TEXT NOT NULL DEFAULT '1.0.0',
  author_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX custom_adapters_company_idx (company_id),
  INDEX custom_adapters_type_idx (adapter_type)
);

-- MCP Tools (exposed by MCP servers)
CREATE TABLE mcp_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB,  -- JSON Schema for tool inputs
  output_schema JSONB, -- JSON Schema for tool outputs
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(server_id, name),
  INDEX mcp_tools_server_idx (server_id)
);

-- MCP Resources
CREATE TABLE mcp_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  name TEXT,
  description TEXT,
  mime_type TEXT,
  content TEXT,  -- Base64-encoded content
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(server_id, uri),
  INDEX mcp_resources_server_idx (server_id)
);

-- Agent + MCP/API Associations
CREATE TABLE agent_api_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_server_id UUID REFERENCES mcp_servers(id) ON DELETE SET NULL,
  api_integration_id UUID REFERENCES external_api_integrations(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  configuration JSONB,  -- Agent-specific API configuration
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX agent_api_associations_agent_idx (agent_id),
  INDEX agent_api_associations_mcp_idx (mcp_server_id),
  INDEX agent_api_associations_api_idx (api_integration_id)
);

-- Webhook/Event subscriptions for external APIs
CREATE TABLE api_event_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES external_api_integrations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- e.g., 'github.push', 'linear.issue_created'
  webhook_url TEXT,
  webhook_secret TEXT,
  filter JSONB,  -- Filter configuration for which events to listen to
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX api_event_subscriptions_integration_idx (integration_id),
  INDEX api_event_subscriptions_agent_idx (agent_id)
);
