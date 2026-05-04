-- Add assigned_by_agent_id and assigned_by_user_id to issues.
-- Records the principal that performed the most recent assignment write
-- (PATCH /api/issues/:id, POST /api/issues/:id/checkout, or initial create with assignee).
-- Null for issues created before this migration.
ALTER TABLE "issues" ADD COLUMN "assigned_by_agent_id" uuid REFERENCES "agents"("id");
ALTER TABLE "issues" ADD COLUMN "assigned_by_user_id" text;
