ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'company';

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS owner_user_id text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS aliases jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS created_by_kind text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS created_by_id text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS updated_by_kind text;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD COLUMN IF NOT EXISTS updated_by_id text;

CREATE INDEX IF NOT EXISTS wiki_pages_company_visibility_idx
  ON plugin_llm_wiki_8f50da974f.wiki_pages (company_id, wiki_id, visibility, owner_user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS wiki_pages_tags_idx
  ON plugin_llm_wiki_8f50da974f.wiki_pages USING gin (tags);

CREATE INDEX IF NOT EXISTS wiki_pages_aliases_idx
  ON plugin_llm_wiki_8f50da974f.wiki_pages USING gin (aliases);

CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_relations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  source_space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  source_page_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_pages(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  target_kind text NOT NULL DEFAULT 'wiki_page',
  target_space_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  target_page_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_pages(id) ON DELETE CASCADE,
  target_path text,
  target_ref text,
  relation_type text NOT NULL DEFAULT 'related',
  label text,
  origin_kind text NOT NULL,
  origin_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_kind text,
  created_by_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS wiki_relations_source_idx
  ON plugin_llm_wiki_8f50da974f.wiki_relations (company_id, wiki_id, source_space_id, source_path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS wiki_relations_target_idx
  ON plugin_llm_wiki_8f50da974f.wiki_relations (company_id, wiki_id, target_space_id, target_path)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wiki_relations_origin_identity_idx
  ON plugin_llm_wiki_8f50da974f.wiki_relations
  (company_id, wiki_id, source_space_id, source_path, target_kind, coalesce(target_space_id::text, ''), coalesce(target_path, ''), coalesce(target_ref, ''), relation_type, origin_kind, coalesce(origin_id::text, ''))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_canvases (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  visibility text NOT NULL DEFAULT 'company',
  owner_user_id text,
  document jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  revision_number integer NOT NULL DEFAULT 1,
  created_by_kind text,
  created_by_id text,
  updated_by_kind text,
  updated_by_id text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_canvases_company_idx
  ON plugin_llm_wiki_8f50da974f.wiki_canvases (company_id, wiki_id, space_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS wiki_canvases_visibility_idx
  ON plugin_llm_wiki_8f50da974f.wiki_canvases (company_id, visibility, owner_user_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_canvas_revisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  canvas_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_canvases(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  title text NOT NULL,
  visibility text NOT NULL,
  document jsonb NOT NULL,
  summary text,
  author_kind text,
  author_id text,
  author_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canvas_id, revision_number)
);

CREATE INDEX IF NOT EXISTS wiki_canvas_revisions_canvas_idx
  ON plugin_llm_wiki_8f50da974f.wiki_canvas_revisions (canvas_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_link_suggestions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  source_space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  source_page_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_pages(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  target_space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  target_page_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_pages(id) ON DELETE CASCADE,
  target_path text NOT NULL,
  relation_type text NOT NULL DEFAULT 'related',
  label text,
  evidence text NOT NULL,
  confidence double precision,
  content_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  proposed_by_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  proposed_by_run_id text,
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wiki_link_suggestions_fingerprint_idx
  ON plugin_llm_wiki_8f50da974f.wiki_link_suggestions
  (company_id, wiki_id, source_space_id, source_path, target_space_id, target_path, relation_type, content_fingerprint);

CREATE INDEX IF NOT EXISTS wiki_link_suggestions_status_idx
  ON plugin_llm_wiki_8f50da974f.wiki_link_suggestions (company_id, wiki_id, status, created_at DESC);
