INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id"
)
SELECT
  "company_id",
  'user',
  "principal_id",
  'commentary:view',
  NULL,
  NULL
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "status" = 'active'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;
