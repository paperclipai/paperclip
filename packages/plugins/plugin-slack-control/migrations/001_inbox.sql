CREATE TABLE plugin_slack_control_608eeb9089.inbox (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  config_digest text NOT NULL,
  message jsonb NOT NULL,
  phase text NOT NULL DEFAULT 'received' CHECK (phase IN ('received', 'working', 'done', 'uncertain')),
  issue_id uuid,
  outcome text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_key)
);
CREATE TABLE plugin_slack_control_608eeb9089.threads (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  slack_user_id text NOT NULL,
  board_user_id text NOT NULL,
  issue_id uuid NOT NULL,
  PRIMARY KEY (company_id, workspace_id, channel_id, thread_ts)
);
