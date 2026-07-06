CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_search_documents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  doc_kind text NOT NULL DEFAULT 'page',
  path text NOT NULL,
  title text,
  body_text text NOT NULL,
  content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, space_id, doc_kind, path)
);

CREATE INDEX IF NOT EXISTS wiki_search_documents_title_trgm_idx
  ON plugin_llm_wiki_8f50da974f.wiki_search_documents USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS wiki_search_documents_body_trgm_idx
  ON plugin_llm_wiki_8f50da974f.wiki_search_documents USING gin (body_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS wiki_search_documents_space_idx
  ON plugin_llm_wiki_8f50da974f.wiki_search_documents (company_id, wiki_id, space_id, updated_at DESC);
