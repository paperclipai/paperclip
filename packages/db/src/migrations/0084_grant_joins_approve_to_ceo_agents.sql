-- Backfill `joins:approve` for existing CEO agents.
-- New CEO agents get this seeded by the server at creation time
-- (see server/src/routes/agents.ts applyDefaultAgentRoleGrants).
-- This migration covers CEO agents created before that change shipped.

INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "agents"."company_id",
  'agent',
  "agents"."id"::text,
  'joins:approve',
  NULL,
  NULL,
  now(),
  now()
FROM "agents"
WHERE "agents"."role" = 'ceo'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
