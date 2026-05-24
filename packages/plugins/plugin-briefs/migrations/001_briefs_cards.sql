CREATE TABLE plugin_briefs_37182b0291.briefs_cards (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  grouping_description text NOT NULL,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('error', 'blocked', 'waiting-user', 'waiting-reviewer', 'live', 'done', 'stale')),
  summary_status text NOT NULL CHECK (summary_status IN ('ok', 'pending', 'fallback')),
  pinned boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  stale_at timestamptz NOT NULL,
  expires_at timestamptz,
  latest_snapshot_id uuid,
  last_meaningful_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, slug)
);

CREATE TABLE plugin_briefs_37182b0291.briefs_card_sources (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES plugin_briefs_37182b0291.briefs_cards(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('issue_tree', 'issue', 'comment', 'run', 'document', 'work_product', 'interaction', 'activity_event', 'approval')),
  source_id text NOT NULL,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  identifier text,
  title_line text NOT NULL,
  right_tag text NOT NULL,
  link_path text NOT NULL,
  is_intra_tree_blocked boolean,
  event_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, source_kind, source_id)
);

CREATE TABLE plugin_briefs_37182b0291.briefs_card_snapshots (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES plugin_briefs_37182b0291.briefs_cards(id) ON DELETE CASCADE,
  summary_paragraph text,
  summary_status text NOT NULL CHECK (summary_status IN ('ok', 'pending', 'fallback')),
  summary_model text,
  summary_tokens_in integer,
  summary_tokens_out integer,
  summary_failure_reason text CHECK (summary_failure_reason IS NULL OR summary_failure_reason IN ('model_error', 'truncation_failed', 'budget_capped', 'safety_block')),
  task_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by_agent_id uuid,
  generated_by_run_id uuid,
  deterministic_state_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plugin_briefs_37182b0291.briefs_cards
  ADD CONSTRAINT briefs_cards_latest_snapshot_fk
  FOREIGN KEY (latest_snapshot_id)
  REFERENCES plugin_briefs_37182b0291.briefs_card_snapshots(id)
  ON DELETE SET NULL;

CREATE TABLE plugin_briefs_37182b0291.briefs_user_preferences (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  cadence text NOT NULL DEFAULT 'hourly' CHECK (cadence IN ('manual', 'hourly', 'daily')),
  retention_days integer NOT NULL DEFAULT 7 CHECK (retention_days > 0),
  done_retention_hours integer NOT NULL DEFAULT 72 CHECK (done_retention_hours > 0),
  stale_after_days integer NOT NULL DEFAULT 7 CHECK (stale_after_days > 0),
  max_unpinned_cards integer NOT NULL DEFAULT 30 CHECK (max_unpinned_cards > 0),
  scope text NOT NULL DEFAULT 'user' CHECK (scope IN ('user')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);

CREATE TABLE plugin_briefs_37182b0291.briefs_cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  cursor_key text NOT NULL,
  cursor_kind text NOT NULL,
  last_seen_at timestamptz,
  overlap_window_start_at timestamptz,
  dedupe_state jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, cursor_key)
);

CREATE INDEX briefs_cards_company_user_state_idx
  ON plugin_briefs_37182b0291.briefs_cards (company_id, user_id, hidden, state, last_meaningful_event_at DESC);

CREATE INDEX briefs_cards_root_issue_idx
  ON plugin_briefs_37182b0291.briefs_cards (company_id, root_issue_id);

CREATE INDEX briefs_card_sources_card_event_idx
  ON plugin_briefs_37182b0291.briefs_card_sources (card_id, event_at DESC);

CREATE INDEX briefs_card_sources_company_source_idx
  ON plugin_briefs_37182b0291.briefs_card_sources (company_id, source_kind, source_id);

CREATE INDEX briefs_card_snapshots_card_created_idx
  ON plugin_briefs_37182b0291.briefs_card_snapshots (card_id, created_at DESC);

CREATE INDEX briefs_cursors_company_user_kind_idx
  ON plugin_briefs_37182b0291.briefs_cursors (company_id, user_id, cursor_kind);
