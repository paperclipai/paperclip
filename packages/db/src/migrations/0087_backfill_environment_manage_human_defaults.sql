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
  "company_id",
  'user',
  "principal_id",
  'environments:manage',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "status" = 'active'
  AND "membership_role" IN ('owner', 'admin')
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;
