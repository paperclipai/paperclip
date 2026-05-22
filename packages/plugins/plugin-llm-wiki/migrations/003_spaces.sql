CREATE TABLE IF NOT EXISTS plugin_llm_wiki_8f50da974f.wiki_spaces (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  slug text NOT NULL,
  display_name text NOT NULL,
  space_type text NOT NULL DEFAULT 'local_folder',
  folder_mode text NOT NULL DEFAULT 'managed_subfolder',
  root_folder_key text NOT NULL DEFAULT 'wiki-root',
  path_prefix text,
  configured_root_path text,
  access_scope text NOT NULL DEFAULT 'shared',
  owner_user_id text,
  owner_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  team_key text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, slug)
);

CREATE INDEX IF NOT EXISTS wiki_spaces_company_status_idx
  ON plugin_llm_wiki_8f50da974f.wiki_spaces (company_id, wiki_id, status);

WITH wiki_pairs AS (
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_instances
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_sources
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_pages
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_page_revisions
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_operations
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.wiki_query_sessions
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.paperclip_distillation_runs
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.paperclip_source_snapshots
  UNION
  SELECT company_id, wiki_id FROM plugin_llm_wiki_8f50da974f.paperclip_page_bindings
)
INSERT INTO plugin_llm_wiki_8f50da974f.wiki_spaces
  (id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key, path_prefix, access_scope, status)
SELECT (
    substr(md5(company_id::text || ':' || wiki_id || ':default'), 1, 8) || '-' ||
    substr(md5(company_id::text || ':' || wiki_id || ':default'), 9, 4) || '-' ||
    '4' || substr(md5(company_id::text || ':' || wiki_id || ':default'), 14, 3) || '-' ||
    '8' || substr(md5(company_id::text || ':' || wiki_id || ':default'), 18, 3) || '-' ||
    substr(md5(company_id::text || ':' || wiki_id || ':default'), 21, 12)
  )::uuid,
  company_id,
  wiki_id,
  'default',
  'default',
  'local_folder',
  'managed_subfolder',
  'wiki-root',
  NULL,
  'shared',
  'active'
FROM wiki_pairs
ON CONFLICT (company_id, wiki_id, slug) DO NOTHING;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_sources ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_operations ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_query_sessions ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots ADD COLUMN IF NOT EXISTS space_id uuid;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings ADD COLUMN IF NOT EXISTS space_id uuid;

UPDATE plugin_llm_wiki_8f50da974f.wiki_sources t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.wiki_pages t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.wiki_page_revisions t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.wiki_operations t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.wiki_query_sessions t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

UPDATE plugin_llm_wiki_8f50da974f.paperclip_page_bindings t
SET space_id = s.id
FROM plugin_llm_wiki_8f50da974f.wiki_spaces s
WHERE t.company_id = s.company_id AND t.wiki_id = s.wiki_id AND s.slug = 'default' AND t.space_id IS NULL;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_sources ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_operations ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_query_sessions ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings ALTER COLUMN space_id SET NOT NULL;

DO $$
DECLARE
  target record;
  constraint_name text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('wiki_pages', ARRAY['company_id', 'wiki_id', 'path']::text[]),
      ('paperclip_distillation_cursors', ARRAY['company_id', 'wiki_id', 'source_scope', 'scope_key', 'source_kind']::text[]),
      ('paperclip_distillation_work_items', ARRAY['company_id', 'wiki_id', 'idempotency_key']::text[]),
      ('paperclip_page_bindings', ARRAY['company_id', 'wiki_id', 'page_path']::text[])
    ) AS targets(table_name, column_names)
  LOOP
    FOR constraint_name IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'plugin_llm_wiki_8f50da974f'
        AND t.relname = target.table_name
        AND c.contype = 'u'
        AND (
          SELECT array_agg(a.attname ORDER BY constraint_columns.ordinality)::text[]
          FROM unnest(c.conkey) WITH ORDINALITY AS constraint_columns(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = constraint_columns.attnum
        ) = target.column_names
    LOOP
      EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', 'plugin_llm_wiki_8f50da974f', target.table_name, constraint_name);
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  DROP CONSTRAINT IF EXISTS wiki_pages_company_wiki_space_path_key;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD CONSTRAINT wiki_pages_company_wiki_space_path_key UNIQUE (company_id, wiki_id, space_id, path);
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors
  DROP CONSTRAINT IF EXISTS distillation_cursors_company_wiki_space_scope_key;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors
  ADD CONSTRAINT distillation_cursors_company_wiki_space_scope_key UNIQUE (company_id, wiki_id, space_id, source_scope, scope_key, source_kind);
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items
  DROP CONSTRAINT IF EXISTS distillation_work_items_company_wiki_space_idempotency_key;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items
  ADD CONSTRAINT distillation_work_items_company_wiki_space_idempotency_key UNIQUE (company_id, wiki_id, space_id, idempotency_key);
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings
  DROP CONSTRAINT IF EXISTS page_bindings_company_wiki_space_page_path_key;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings
  ADD CONSTRAINT page_bindings_company_wiki_space_page_path_key UNIQUE (company_id, wiki_id, space_id, page_path);

ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_sources
  DROP CONSTRAINT IF EXISTS wiki_sources_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_sources
  ADD CONSTRAINT wiki_sources_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  DROP CONSTRAINT IF EXISTS wiki_pages_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_pages
  ADD CONSTRAINT wiki_pages_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  DROP CONSTRAINT IF EXISTS wiki_page_revisions_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions
  ADD CONSTRAINT wiki_page_revisions_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_operations
  DROP CONSTRAINT IF EXISTS wiki_operations_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_operations
  ADD CONSTRAINT wiki_operations_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_query_sessions
  DROP CONSTRAINT IF EXISTS wiki_query_sessions_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.wiki_query_sessions
  ADD CONSTRAINT wiki_query_sessions_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors
  DROP CONSTRAINT IF EXISTS paperclip_distillation_cursors_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors
  ADD CONSTRAINT paperclip_distillation_cursors_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items
  DROP CONSTRAINT IF EXISTS paperclip_distillation_work_items_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items
  ADD CONSTRAINT paperclip_distillation_work_items_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs
  DROP CONSTRAINT IF EXISTS paperclip_distillation_runs_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs
  ADD CONSTRAINT paperclip_distillation_runs_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots
  DROP CONSTRAINT IF EXISTS paperclip_source_snapshots_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots
  ADD CONSTRAINT paperclip_source_snapshots_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings
  DROP CONSTRAINT IF EXISTS paperclip_page_bindings_space_id_fk;
ALTER TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings
  ADD CONSTRAINT paperclip_page_bindings_space_id_fk FOREIGN KEY (space_id) REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS wiki_sources_space_idx ON plugin_llm_wiki_8f50da974f.wiki_sources (company_id, wiki_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wiki_operations_space_idx ON plugin_llm_wiki_8f50da974f.wiki_operations (company_id, wiki_id, space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wiki_query_sessions_space_idx ON plugin_llm_wiki_8f50da974f.wiki_query_sessions (company_id, wiki_id, space_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS distillation_runs_space_idx ON plugin_llm_wiki_8f50da974f.paperclip_distillation_runs (company_id, wiki_id, space_id, created_at DESC);
