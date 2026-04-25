-- Add role_bound FK from agents to agent_role_definitions
-- This formally binds an agent to a role definition

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "role_bound" uuid REFERENCES "agent_role_definitions"("id");

CREATE INDEX IF NOT EXISTS "agents_role_bound_idx" ON "agents" ("role_bound") WHERE "role_bound" IS NOT NULL;
