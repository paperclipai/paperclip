-- Deliberation Protocol: structured multi-agent discussion tables

CREATE TABLE IF NOT EXISTS channel_deliberations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  topic text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  synthesis_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_deliberations_company_idx ON channel_deliberations(company_id);
CREATE INDEX IF NOT EXISTS channel_deliberations_channel_idx ON channel_deliberations(channel_id);
CREATE INDEX IF NOT EXISTS channel_deliberations_status_idx ON channel_deliberations(company_id, status);

CREATE TABLE IF NOT EXISTS channel_deliberation_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id uuid NOT NULL REFERENCES channel_deliberations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position_text text NOT NULL,
  evidence_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_deliberation_positions_delib_idx ON channel_deliberation_positions(deliberation_id);

CREATE TABLE IF NOT EXISTS channel_deliberation_rebuttals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id uuid NOT NULL REFERENCES channel_deliberations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_position_id uuid NOT NULL REFERENCES channel_deliberation_positions(id) ON DELETE CASCADE,
  rebuttal_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_deliberation_rebuttals_delib_idx ON channel_deliberation_rebuttals(deliberation_id);
