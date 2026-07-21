CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  source_scope text NOT NULL,
  scope_key text NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  source_kind text NOT NULL DEFAULT 'paperclip_issue_history',
  last_processed_at timestamptz,
  last_observed_at timestamptz,
  pending_event_count integer NOT NULL DEFAULT 0,
  last_successful_run_id uuid,
  last_source_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, source_scope, scope_key, source_kind)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  work_item_kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'medium',
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  requested_by_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, idempotency_key)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  cursor_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors(id) ON DELETE SET NULL,
  work_item_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_window_start timestamptz,
  source_window_end timestamptz,
  source_hash text,
  status text NOT NULL,
  operation_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  retry_count integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  distillation_run_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_runs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_hash text NOT NULL,
  max_characters integer NOT NULL,
  clipped boolean NOT NULL DEFAULT false,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  bundle_markdown text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  page_path text NOT NULL,
  last_applied_source_hash text,
  last_distillation_run_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_runs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, page_path)
);
