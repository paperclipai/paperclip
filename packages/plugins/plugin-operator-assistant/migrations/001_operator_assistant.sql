CREATE TABLE plugin_operator_assistant_f91560dc87.assistant_chat_sessions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL,
  title text NOT NULL DEFAULT 'New conversation',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_operator_assistant_f91560dc87.assistant_chat_messages (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  chat_session_id uuid NOT NULL REFERENCES plugin_operator_assistant_f91560dc87.assistant_chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  run_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_chat_sessions_company_updated_idx
  ON plugin_operator_assistant_f91560dc87.assistant_chat_sessions(company_id, updated_at DESC);

CREATE INDEX assistant_chat_messages_session_created_idx
  ON plugin_operator_assistant_f91560dc87.assistant_chat_messages(chat_session_id, created_at ASC);
