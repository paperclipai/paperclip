CREATE TABLE plugin_orchestration_smoke_04cd6cb34f.smoke_runs (
  id uuid PRIMARY KEY,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  child_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  blocker_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  billing_code text NOT NULL,
  last_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
