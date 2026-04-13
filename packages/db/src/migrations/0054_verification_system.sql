-- 0054_verification_system.sql
-- Phase 1 of server-side verification replacing honor-system QA gates.
-- See docs/plans/2026-04-13-verification-system-design-v2.md and DLD-2793 incident.

CREATE TABLE verification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  deliverable_type text NOT NULL,
  spec_path text NOT NULL,
  context text,
  target_sha text,
  deployed_sha text,
  status text NOT NULL,
  trace_asset_id uuid REFERENCES assets(id),
  failure_summary text,
  unavailable_reason text,
  attempt_number integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  CONSTRAINT verification_runs_status_check CHECK (status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden')),
  CONSTRAINT verification_runs_context_check CHECK (context IS NULL OR context IN ('anonymous', 'authenticated'))
);
CREATE INDEX verification_runs_issue_idx ON verification_runs(issue_id, started_at DESC);

CREATE TABLE verification_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id uuid NOT NULL REFERENCES verification_runs(id),
  current_rung integer NOT NULL DEFAULT 0,
  next_rung_at timestamptz NOT NULL,
  escalated_to_manager_at timestamptz,
  escalated_to_ceo_at timestamptz,
  escalated_to_board_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_escalations_resolution_check CHECK (resolution IS NULL OR resolution IN ('passed', 'overridden', 'reverted'))
);
CREATE INDEX verification_escalations_open_idx ON verification_escalations(next_rung_at) WHERE resolved_at IS NULL;

CREATE TABLE verification_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  verification_run_id uuid REFERENCES verification_runs(id),
  user_id text NOT NULL,
  justification text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_overrides_justification_length CHECK (length(justification) >= 20)
);

CREATE TABLE spec_metadata (
  spec_path text PRIMARY KEY,
  total_runs integer NOT NULL DEFAULT 0,
  pass_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  flake_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_flake_at timestamptz,
  flaky boolean NOT NULL DEFAULT false,
  maintenance_issue_id uuid REFERENCES issues(id)
);

CREATE TABLE verification_chaos_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario text NOT NULL,
  expected_outcome text NOT NULL,
  actual_outcome text NOT NULL,
  passed boolean NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE issues
  ADD COLUMN deliverable_type text,
  ADD COLUMN verification_target text,
  ADD COLUMN verification_run_id uuid REFERENCES verification_runs(id),
  ADD COLUMN verification_status text,
  ADD COLUMN multi_atomic boolean NOT NULL DEFAULT false,
  ADD COLUMN risk_high boolean NOT NULL DEFAULT false,
  ADD COLUMN incident_priority boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT issues_verification_status_check CHECK (verification_status IS NULL OR verification_status IN ('pending', 'running', 'passed', 'failed', 'unavailable', 'overridden'));

CREATE INDEX issues_verification_status_idx ON issues(verification_status) WHERE verification_status IS NOT NULL;
