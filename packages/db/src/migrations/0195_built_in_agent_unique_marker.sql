-- Enforce one active built-in agent per (company, marker key).
--
-- Provisioning used to check-then-insert with no database guard, so two
-- concurrent server processes could each see "no summarizer exists" and both
-- insert, leaving a company with duplicate built-in agents plus paired orphan
-- pending hire_agent approvals.
--
-- Step 1: resolve any pre-existing duplicates so the unique index below can be
-- created. Keep the oldest marked row per (company, key), terminate the newer
-- duplicates, cancel their orphan pending hire_agent approvals, and revoke any
-- API keys those terminated rows held.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, (metadata -> 'paperclipBuiltInAgent' ->> 'key')
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM agents
  WHERE (metadata -> 'paperclipBuiltInAgent' ->> 'key') IS NOT NULL
    AND status <> 'terminated'
),
duplicates AS (
  SELECT id FROM ranked WHERE rn > 1
),
terminated AS (
  UPDATE agents
  SET status = 'terminated', updated_at = now()
  WHERE id IN (SELECT id FROM duplicates)
  RETURNING id
),
cancelled_approvals AS (
  UPDATE approvals
  SET status = 'cancelled', updated_at = now()
  WHERE type = 'hire_agent'
    AND status IN ('pending', 'revision_requested')
    AND (payload ->> 'agentId') IN (SELECT id::text FROM terminated)
  RETURNING id
)
UPDATE agent_api_keys
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND agent_id IN (SELECT id FROM terminated);
--> statement-breakpoint

-- Step 2: enforce uniqueness going forward. A partial unique index lets the
-- provisioning race lose cleanly (the losing INSERT raises 23505, which
-- provision()/ensure() catch and re-resolve to the winner's row). Terminated
-- rows are excluded so re-provisioning after a termination stays possible.
CREATE UNIQUE INDEX IF NOT EXISTS "agents_company_built_in_agent_key_unique_idx"
  ON "agents" ("company_id", ((metadata -> 'paperclipBuiltInAgent' ->> 'key')))
  WHERE (metadata -> 'paperclipBuiltInAgent' ->> 'key') IS NOT NULL
    AND status <> 'terminated';
