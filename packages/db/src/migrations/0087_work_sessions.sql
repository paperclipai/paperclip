CREATE TABLE work_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  agent_id uuid REFERENCES agents(id),
  status text NOT NULL DEFAULT 'active',
  start_time timestamp with time zone NOT NULL DEFAULT now(),
  end_time timestamp with time zone,
  duration integer,
  git_branch text,
  summary text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX work_sessions_company_idx ON work_sessions(company_id);
CREATE INDEX work_sessions_status_idx ON work_sessions(status);
CREATE INDEX work_sessions_start_time_idx ON work_sessions(start_time);

CREATE TABLE session_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  timestamp timestamp with time zone NOT NULL DEFAULT now(),
  git_branch text,
  open_files jsonb,
  unfinished_tasks jsonb,
  recent_changes jsonb,
  summary text,
  context_score integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX session_snapshots_session_idx ON session_snapshots(session_id);
CREATE INDEX session_snapshots_timestamp_idx ON session_snapshots(timestamp);
