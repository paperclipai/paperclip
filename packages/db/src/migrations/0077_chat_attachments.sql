-- Clippy attachments: images, PDFs, and other files the user drops/pastes
-- into a chat. Files live on disk under
-- ~/.paperclip/instances/<instance>/data/clippy-attachments/<id>; this table
-- is the index. Owned by the session (cascade-deleted with it) and keyed by
-- the uploading board user so we can authorise downloads even when the
-- session has no company.

CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  board_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'file')),
  media_type text NOT NULL,
  name text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_attachments_session_idx
  ON chat_attachments (session_id, created_at);
