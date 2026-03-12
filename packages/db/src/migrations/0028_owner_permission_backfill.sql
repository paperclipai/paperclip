INSERT INTO principal_permission_grants (id, company_id, principal_type, principal_id, permission_key, scope, granted_by_user_id, created_at, updated_at)
SELECT gen_random_uuid(), cm.company_id, cm.principal_type, cm.principal_id, pk.permission_key, NULL, NULL, NOW(), NOW()
FROM company_memberships cm
CROSS JOIN (VALUES ('users:invite'), ('users:manage_permissions'), ('agents:create'), ('tasks:assign'), ('tasks:assign_scope'), ('joins:approve')) AS pk(permission_key)
WHERE cm.membership_role = 'owner'
ON CONFLICT DO NOTHING;
