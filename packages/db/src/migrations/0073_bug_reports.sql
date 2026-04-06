CREATE TABLE IF NOT EXISTS bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  reported_by_user_id text REFERENCES "user"(id),
  type text NOT NULL DEFAULT 'bug',
  title text NOT NULL,
  description text,
  page_url text,
  severity text DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  admin_notes text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bug_reports_company_idx ON bug_reports(company_id);
CREATE INDEX IF NOT EXISTS bug_reports_status_idx ON bug_reports(status);
