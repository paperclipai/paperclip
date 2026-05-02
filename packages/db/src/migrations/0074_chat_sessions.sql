-- "Ask Paperclip" agent chat: sessions and messages.
-- Each session is owned by a board user; agents do not get chat sessions.
-- mode = 'chat' (no tools) | 'agent' (tool use enabled)
-- permission_mode = 'ask' (prompt before each mutating tool) | 'bypass' (auto-approve)
-- effort maps to Anthropic's extended-thinking budget hint (auto/low/medium/high).
-- chat_messages.content holds Anthropic-shape blocks (text, tool_use, tool_result)
-- as JSONB so a session can be replayed verbatim into the SDK on the next turn.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_user_id text NOT NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'New chat',
  model text NOT NULL DEFAULT 'claude-opus-4-7',
  mode text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'agent')),
  permission_mode text NOT NULL DEFAULT 'ask' CHECK (permission_mode IN ('ask', 'bypass')),
  effort text NOT NULL DEFAULT 'auto' CHECK (effort IN ('auto', 'low', 'medium', 'high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_idx
  ON chat_sessions (board_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON chat_messages (session_id, created_at);
