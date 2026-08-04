CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.notion_sync_cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  notion_page_id text NOT NULL,
  wiki_path text NOT NULL,
  notion_last_edited_time timestamptz,
  notion_content_hash text,
  wiki_content_hash text,
  origin text NOT NULL DEFAULT 'notion',
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, space_id, notion_page_id),
  UNIQUE (company_id, wiki_id, space_id, wiki_path)
);

CREATE INDEX IF NOT EXISTS notion_sync_cursors_company_wiki_idx
  ON plugin_llm_wiki_8f50da974f.notion_sync_cursors (company_id, wiki_id, space_id, updated_at DESC);
