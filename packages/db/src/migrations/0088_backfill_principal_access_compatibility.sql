INSERT INTO "company_memberships" (
  "company_id",
  "principal_type",
  "principal_id",
  "status",
  "membership_role",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  'agent',
  "id",
  'active',
  'member',
  now(),
  now()
FROM "agents"
WHERE "status" NOT IN ('pending_approval', 'terminated')
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id"
) DO NOTHING;

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
  memberships."company_id",
  'user',
  memberships."principal_id",
  role_defaults."permission_key",
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships" memberships
JOIN (
  VALUES
    ('owner', 'agents:create'),
    ('owner', 'environments:manage'),
    ('owner', 'users:invite'),
    ('owner', 'users:manage_permissions'),
    ('owner', 'tasks:assign'),
    ('owner', 'joins:approve'),
    ('admin', 'agents:create'),
    ('admin', 'environments:manage'),
    ('admin', 'users:invite'),
    ('admin', 'tasks:assign'),
    ('admin', 'joins:approve'),
    ('operator', 'tasks:assign')
) AS role_defaults("membership_role", "permission_key")
  ON role_defaults."membership_role" = CASE
    WHEN memberships."membership_role" = 'owner' THEN 'owner'
    WHEN memberships."membership_role" = 'admin' THEN 'admin'
    WHEN memberships."membership_role" = 'viewer' THEN 'viewer'
    WHEN memberships."membership_role" = 'member' THEN 'operator'
    ELSE 'operator'
  END
WHERE memberships."principal_type" = 'user'
  AND memberships."status" = 'active'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;
