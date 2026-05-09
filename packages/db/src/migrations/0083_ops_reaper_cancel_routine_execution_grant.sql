-- GLA-1064: Grant `tasks:cancel_routine_execution` to OpsReaper at the Gladia
-- company (`050de589`). The route bypass added in this change allows an agent
-- holding this permission to PATCH status=cancelled on a routine_execution
-- issue assigned to a different agent (Spec §11.a). Without the grant the
-- bypass is inert.
--
-- INSERT is conditional: skip silently when the company or the agent does not
-- exist on this instance (other deployments). The unique index on
-- (company_id, principal_type, principal_id, permission_key) makes the insert
-- idempotent across re-runs via ON CONFLICT DO NOTHING.

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
  '050de589-23d3-40bb-b227-efea13164d01'::uuid,
  'agent',
  '16d0232f-1249-4db9-82d6-ab237c926e59',
  'tasks:cancel_routine_execution',
  NULL,
  NULL,
  now(),
  now()
WHERE EXISTS (
  SELECT 1 FROM "companies" WHERE "id" = '050de589-23d3-40bb-b227-efea13164d01'::uuid
)
AND EXISTS (
  SELECT 1 FROM "agents" WHERE "id" = '16d0232f-1249-4db9-82d6-ab237c926e59'::uuid
)
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;

-- Rollback (manual; not a drizzle automatic down):
--   DELETE FROM "principal_permission_grants"
--   WHERE "company_id" = '050de589-23d3-40bb-b227-efea13164d01'::uuid
--     AND "principal_type" = 'agent'
--     AND "principal_id"  = '16d0232f-1249-4db9-82d6-ab237c926e59'
--     AND "permission_key" = 'tasks:cancel_routine_execution';
