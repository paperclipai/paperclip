-- REQ-01: Spec enforcement on issue creation
ALTER TABLE issues ADD COLUMN IF NOT EXISTS spec_template JSONB;

-- REQ-05: Crawl-Walk-Run workflow maturity
CREATE TABLE IF NOT EXISTS workflow_maturity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  workflow_type TEXT NOT NULL,
  maturity_level TEXT NOT NULL DEFAULT 'crawl' CHECK (maturity_level IN ('crawl', 'walk', 'run')),
  total_completed INTEGER NOT NULL DEFAULT 0,
  consecutive_passes INTEGER NOT NULL DEFAULT 0,
  rejections_last_20 INTEGER NOT NULL DEFAULT 0,
  promoted_at TIMESTAMPTZ,
  promoted_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_maturity_company_workflow_idx ON workflow_maturity(company_id, workflow_type);
