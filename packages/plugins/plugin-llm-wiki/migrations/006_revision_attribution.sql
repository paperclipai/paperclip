ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  ADD COLUMN IF NOT EXISTS author_kind text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  ADD COLUMN IF NOT EXISTS author_id text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  ADD COLUMN IF NOT EXISTS author_run_id text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  ADD COLUMN IF NOT EXISTS contents text;
