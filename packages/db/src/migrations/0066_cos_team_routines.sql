-- Phase 5.2b: Team-scoped routines
--
-- The user's model for "Cycles": team-level recurring work (daily standups,
-- weekly retros, etc.) that leader agents execute. Paperclip's existing
-- routines table is perfect for this — it already has cron, concurrency
-- policy, catch-up, variables, runs history. The only gap was that
-- `project_id` was NOT NULL, forcing every routine to live under a
-- project.
--
-- This migration:
--   1. Adds `team_id` as a nullable FK to teams(id).
--   2. Relaxes `project_id` to nullable.
--   3. Adds a CHECK constraint: at least one of (project_id, team_id)
--      must be set, so routines always have a scope.
--   4. Adds an index on (company_id, team_id) for team-scoped listing.
--
-- The dispatch path (dispatchRoutineRun → issues.create) will forward
-- team_id to the created issue so team-scoped routines create issues on
-- the owning team, not an arbitrary project.

ALTER TABLE routines
  ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

ALTER TABLE routines
  ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE routines
  ADD CONSTRAINT routines_scope_chk
  CHECK (project_id IS NOT NULL OR team_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS routines_company_team_idx
  ON routines (company_id, team_id);
