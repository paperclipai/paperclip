-- paperclip_chat_memory.sql
-- Chat-Memory für den Paperclip CEO Voice & Telegram Workflow (V1).
-- Schema ist identisch zu n8n_chat_histories, so wie es das
-- LangChain-Postgres-Chat-Memory-Node erwartet (JSONB message-Spalte).

CREATE TABLE IF NOT EXISTS paperclip_chat_memory (
  id          serial                PRIMARY KEY,
  session_id  varchar(255)          NOT NULL,
  message     jsonb                 NOT NULL
);

CREATE INDEX IF NOT EXISTS paperclip_chat_memory_session_idx
  ON paperclip_chat_memory (session_id);
