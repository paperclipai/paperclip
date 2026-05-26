-- Backfill `tasks:view_all` for every active human company membership so
-- existing deployments see no behavior change after this permission key is
-- introduced.
--
-- WHERE NOT EXISTS instead of ON CONFLICT DO NOTHING: this preserves admin
-- revocations across re-runs. ON CONFLICT only matches active grants; if an
-- admin had revoked the row (whether via hard-delete on the legacy schema or
-- a tombstone after migration 0093), the conflict path would skip the insert
-- BUT only because the unique index covers active rows. NOT EXISTS scans both
-- active and tombstoned rows for the same (company, principal, key) and skips
-- when EITHER exists — silently re-applying default access is never desirable
-- for a permission revoke. See 0093_grant_revocation_tombstones.sql for the
-- soft-delete contract this depends on.
INSERT INTO "principal_permission_grants"
  ("id", "company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  m."company_id",
  m."principal_type",
  m."principal_id",
  'tasks:view_all',
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
      AND g."permission_key" = 'tasks:view_all'
  );
