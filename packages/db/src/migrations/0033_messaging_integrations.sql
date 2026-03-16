-- Messaging Integrations System
-- Enables multi-channel communication (Telegram, WhatsApp, Slack, Email)

-- Messaging platforms/connectors
CREATE TABLE messaging_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'telegram', 'whatsapp', 'slack', 'email'
  name TEXT NOT NULL,
  configuration JSONB NOT NULL,  -- API keys, tokens, webhook URLs, etc.
  status TEXT NOT NULL DEFAULT 'inactive', -- 'active', 'inactive', 'error'
  error_message TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX messaging_connectors_company_idx (company_id),
  INDEX messaging_connectors_platform_idx (platform)
);

-- Messaging channels (agent-specific message endpoints)
CREATE TABLE messaging_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL REFERENCES messaging_connectors(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_identifier TEXT NOT NULL, -- Telegram chat ID, Slack channel, email, etc.
  channel_type TEXT, -- 'direct', 'group', 'channel'
  metadata JSONB,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(connector_id, agent_id, channel_identifier),
  INDEX messaging_channels_agent_idx (agent_id),
  INDEX messaging_channels_connector_idx (connector_id)
);

-- Message history (inbound and outbound messages)
CREATE TABLE messaging_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES messaging_channels(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  direction TEXT NOT NULL, -- 'inbound', 'outbound'
  platform_message_id TEXT,  -- External message ID
  sender_identifier TEXT,  -- User ID in external platform
  sender_name TEXT,
  content TEXT NOT NULL,
  content_type TEXT, -- 'text', 'media', 'media_url'
  media_url TEXT,
  attachment_data JSONB,
  status TEXT, -- 'pending', 'sent', 'delivered', 'read', 'failed'
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  INDEX messaging_messages_channel_idx (channel_id),
  INDEX messaging_messages_agent_idx (agent_id),
  INDEX messaging_messages_created_idx (created_at)
);

-- Message processing logs
CREATE TABLE messaging_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL REFERENCES messaging_connectors(id) ON DELETE CASCADE,
  webhook_event TEXT NOT NULL,
  payload JSONB,
  status TEXT, -- 'processed', 'failed', 'pending_retry'
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  INDEX messaging_webhooks_connector_idx (connector_id),
  INDEX messaging_webhooks_status_idx (status)
);

-- User mappings (connect external users to agents)
CREATE TABLE messaging_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id UUID NOT NULL REFERENCES messaging_connectors(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  external_metadata JSONB,  -- Name, avatar, etc.
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(connector_id, external_user_id),
  INDEX messaging_user_mappings_connector_idx (connector_id),
  INDEX messaging_user_mappings_agent_idx (agent_id)
);
