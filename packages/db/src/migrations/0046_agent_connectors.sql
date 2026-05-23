-- Agent OAuth connectors - per-agent OAuth connections
CREATE TABLE agent_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connector_type text NOT NULL,
  provider text NOT NULL,
  display_name text,
  access_token text,
  refresh_token text,
  token_expires_at timestamp with time zone,
  scopes jsonb,
  provider_data jsonb,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  connected_at timestamp with time zone DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX agent_connectors_agent_id_idx ON agent_connectors(agent_id);
CREATE INDEX agent_connectors_provider_idx ON agent_connectors(provider);
CREATE UNIQUE INDEX agent_connectors_unique_agent_type ON agent_connectors(agent_id, connector_type);

COMMENT ON TABLE agent_connectors IS 'Per-agent OAuth connections - enables each agent to have its own connected services (Google, Slack, etc.)';
COMMENT ON COLUMN agent_connectors.connector_type IS 'Type of connector (oauth, api_key, etc.)';
COMMENT ON COLUMN agent_connectors.provider IS 'OAuth provider identifier (google_workspace, slack, github, etc.)';
COMMENT ON COLUMN agent_connectors.access_token IS 'Encrypted OAuth access token';
COMMENT ON COLUMN agent_connectors.refresh_token IS 'Encrypted OAuth refresh token';
COMMENT ON COLUMN agent_connectors.scopes IS 'Array of OAuth scopes that were granted';
COMMENT ON COLUMN agent_connectors.provider_data IS 'Provider-specific user info (email, name, avatar URL)';
COMMENT ON COLUMN agent_connectors.status IS 'Connection status: pending, connected, error, revoked';
