-- paperclip_chat_memory.sql
-- Chat-Memory für den Paperclip CEO Voice & Telegram Workflow (V1).
-- Separate Tabelle, damit Luna-Memory (tg_chat_memory) nicht vermischt wird.

CREATE TABLE IF NOT EXISTS paperclip_chat_memory (
  id         bigserial PRIMARY KEY,
  session_id text        NOT NULL,
  role       text        NOT NULL,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paperclip_chat_memory_session_idx
  ON paperclip_chat_memory (session_id, created_at DESC);
