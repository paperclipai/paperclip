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
  "principal_type",
  "principal_id",
  'skills:create',
  "scope",
  "granted_by_user_id",
  "created_at",
  now()
FROM "principal_permission_grants"
WHERE "permission_key" = 'skill:create'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;

DELETE FROM "principal_permission_grants"
WHERE "permission_key" = 'skill:create';
