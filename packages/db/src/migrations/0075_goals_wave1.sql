-- Wave 1: Goals foundation enhancements
-- Adds confidence scoring, health tracking, start date/cadence, goal type
-- Plus check-ins and snapshots tables

-- Confidence scoring (0-100, default 50)
ALTER TABLE goals ADD COLUMN IF NOT EXISTS confidence INTEGER DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100);

-- Unified health scoring
ALTER TABLE goals ADD COLUMN IF NOT EXISTS health_score INTEGER CHECK (health_score BETWEEN 0 AND 100);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS health_status TEXT CHECK (health_status IN ('on_track', 'at_risk', 'off_track', 'achieved', 'no_data'));

-- Start date and cadence
ALTER TABLE goals ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS cadence TEXT DEFAULT 'quarterly' CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'annual', 'custom'));

-- Goal type (committed vs aspirational)
ALTER TABLE goals ADD COLUMN IF NOT EXISTS goal_type TEXT DEFAULT 'committed' CHECK (goal_type IN ('committed', 'aspirational'));

-- Check-ins table
CREATE TABLE IF NOT EXISTS goal_check_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  author_agent_id UUID REFERENCES agents(id),
  author_user_id TEXT REFERENCES "user"(id),
  progress_percent NUMERIC(5,2),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track', 'at_risk', 'off_track', 'achieved', 'cancelled')),
  note TEXT,
  blockers TEXT,
  next_steps TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_check_ins_goal_idx ON goal_check_ins(goal_id);
CREATE INDEX IF NOT EXISTS goal_check_ins_created_idx ON goal_check_ins(created_at);

-- Snapshots table (for historical tracking)
CREATE TABLE IF NOT EXISTS goal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  snapshot_date DATE NOT NULL,
  progress_percent NUMERIC(5,2),
  health_score INTEGER,
  confidence INTEGER,
  total_issues INTEGER,
  completed_issues INTEGER,
  blocked_issues INTEGER,
  budget_spent_cents BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_snapshots_goal_date_idx ON goal_snapshots(goal_id, snapshot_date);
