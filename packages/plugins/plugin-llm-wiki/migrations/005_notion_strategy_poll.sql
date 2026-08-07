CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.notion_strategy_poll_cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  notion_page_id text NOT NULL,
  notion_page_id_normalized text NOT NULL,
  notion_last_edited_time timestamptz NOT NULL,
  emitted_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  emitted_issue_identifier text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, space_id, notion_page_id_normalized, notion_last_edited_time)
);

CREATE INDEX IF NOT EXISTS notion_strategy_poll_cursor_watermark_idx
  ON plugin_llm_wiki_8f50da974f.notion_strategy_poll_cursors
  (company_id, wiki_id, space_id, notion_last_edited_time DESC);
