-- Backfill `agents:view_all` for every active human company membership so
-- existing deployments see no behavior change after this permission key is
-- introduced. Mirrors 0091_grant_tasks_view_all_default exactly.
--
-- WHERE NOT EXISTS skips both active and tombstoned rows so an admin
-- revocation survives migration re-runs (see 0093_grant_revocation_tombstones).
INSERT INTO "principal_permission_grants"
  ("id", "company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  m."company_id",
  m."principal_type",
  m."principal_id",
  'agents:view_all',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" m
WHERE m."principal_type" = 'user'
  AND m."status" = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM "principal_permission_grants" g
    WHERE g."company_id" = m."company_id"
      AND g."principal_type" = m."principal_type"
      AND g."principal_id" = m."principal_id"
      AND g."permission_key" = 'agents:view_all'
  );
