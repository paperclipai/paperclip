ALTER TABLE issues ADD COLUMN IF NOT EXISTS work_item_type TEXT NOT NULL DEFAULT 'ai_task';

-- Backfill: parent items with no agent assigned are likely human/initiative tasks
UPDATE issues 
SET work_item_type = 'initiative' 
WHERE parent_id IS NULL 
  AND assignee_agent_id IS NULL 
  AND work_item_type = 'ai_task';

-- Add index for filtering
CREATE INDEX IF NOT EXISTS issues_company_work_item_type_idx ON issues(company_id, work_item_type);
