CREATE TABLE plugin_clarifier_9e2ef9ecdc.clarifier_eligible (
  id uuid PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  eligible boolean NOT NULL,
  signals text[] NOT NULL DEFAULT ARRAY[]::text[],
  trigger_kind text NOT NULL,
  trigger_event_id text,
  trigger_comment_id uuid,
  issue_status text,
  issue_assignee_agent_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX clarifier_eligible_issue_eval_idx
  ON plugin_clarifier_9e2ef9ecdc.clarifier_eligible (issue_id, evaluated_at DESC);
