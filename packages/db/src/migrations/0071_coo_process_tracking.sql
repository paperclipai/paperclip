-- Add blockedAt timestamp to issues (set when status changes to blocked)
ALTER TABLE issues ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

-- Add statusChangedAt timestamp to issues (set on every status change)
ALTER TABLE issues ADD COLUMN IF NOT EXISTS status_changed_at timestamptz DEFAULT now();

-- Create issue status change history table
CREATE TABLE IF NOT EXISTS issue_status_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status text NOT NULL,
  changed_by_agent_id uuid REFERENCES agents(id),
  changed_by_user_id text REFERENCES "user"(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_status_changes_issue_idx ON issue_status_changes(issue_id);
CREATE INDEX IF NOT EXISTS issue_status_changes_company_idx ON issue_status_changes(company_id, changed_at);
