-- Backfill `tasks:view_all` for every active human company membership so
-- existing deployments see no behavior change after this permission key is
-- introduced. Idempotent via the unique grant index; safe to replay.
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
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
