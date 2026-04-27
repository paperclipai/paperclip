-- Dark Factory bridge projection POC namespace tables.
-- These tables intentionally store only derived projection/cache/cursor/receipt data.
-- They do not store secrets, tokens, provider credentials, or authoritative Dark Factory Journal records.
-- The Dark Factory Journal remains the truth source; this plugin namespace is not a second truth source.

CREATE TABLE IF NOT EXISTS dark_factory_bridge_poc.projection_cache (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  linked_run_id text NOT NULL,
  projection_status text NOT NULL,
  projection_payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'dark-factory-projection',
  truth_source text NOT NULL DEFAULT 'dark-factory-journal',
  authoritative boolean NOT NULL DEFAULT false,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dark_factory_bridge_poc_projection_cache_issue_idx
  ON dark_factory_bridge_poc.projection_cache (company_id, issue_id);

CREATE TABLE IF NOT EXISTS dark_factory_bridge_poc.journal_cursors (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  linked_run_id text NOT NULL,
  last_journal_sequence_no integer NOT NULL,
  journal_ref text NOT NULL,
  monotonic boolean NOT NULL DEFAULT true,
  gap_detected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dark_factory_bridge_poc_journal_cursors_company_issue_unique
  ON dark_factory_bridge_poc.journal_cursors (company_id, issue_id);

CREATE TABLE IF NOT EXISTS dark_factory_bridge_poc.callback_receipts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  linked_run_id text NOT NULL,
  idempotency_key text NOT NULL,
  receipt_status text NOT NULL,
  terminal_state_advanced boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dark_factory_bridge_poc_callback_receipts_idempotency_idx
  ON dark_factory_bridge_poc.callback_receipts (company_id, idempotency_key);

CREATE TABLE IF NOT EXISTS dark_factory_bridge_poc.rehydrate_requests (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  linked_run_id text NOT NULL,
  reason text,
  request_status text NOT NULL DEFAULT 'requested',
  terminal_state_advanced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
