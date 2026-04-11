-- Add issue_type column to support initiative/task hierarchy
ALTER TABLE issues ADD COLUMN issue_type text NOT NULL DEFAULT 'task';

-- Backfill: issues that have children and no parent become initiatives
UPDATE issues SET issue_type = 'initiative'
WHERE parent_id IS NULL
AND id IN (SELECT DISTINCT parent_id FROM issues WHERE parent_id IS NOT NULL);

-- Add check constraint for valid issue_type values
ALTER TABLE issues ADD CONSTRAINT issues_issue_type_check
CHECK (issue_type IN ('initiative', 'task'));

-- Index for fast initiative queries and groupBy filtering
CREATE INDEX issues_company_type_idx ON issues (company_id, issue_type);
