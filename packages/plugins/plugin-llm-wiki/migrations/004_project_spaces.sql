ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_spaces
  ADD COLUMN IF NOT EXISTS binding_kind text NOT NULL DEFAULT 'none';

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_spaces
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wiki_spaces_project_binding_key
  ON plugin_llm_wiki_8f50da974f.wiki_spaces (company_id, wiki_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS wiki_spaces_binding_kind_idx
  ON plugin_llm_wiki_8f50da974f.wiki_spaces (company_id, wiki_id, binding_kind, status);
