-- Slack integration fields on business_configs
ALTER TABLE business_configs ADD COLUMN IF NOT EXISTS slack_bot_token_secret_name TEXT NOT NULL DEFAULT 'business-slack-bot-token';
ALTER TABLE business_configs ADD COLUMN IF NOT EXISTS slack_signing_secret_name TEXT NOT NULL DEFAULT 'business-slack-signing-secret';
ALTER TABLE business_configs ADD COLUMN IF NOT EXISTS slack_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE business_configs ADD COLUMN IF NOT EXISTS slack_default_channel_id TEXT;

-- Slack conversations table for channel-thread-agent mappings
CREATE TABLE IF NOT EXISTS slack_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  thread_ts TEXT,
  agent_id UUID,
  issue_id UUID,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS slack_conv_company_channel_thread_idx
  ON slack_conversations (company_id, channel_id, thread_ts);
