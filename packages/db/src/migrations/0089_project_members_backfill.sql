-- Backfill: add all active user company members as project_members with
-- `super_admin` role for every existing project, so privacy enforcement does
-- not remove access from anyone who had it before this release.
-- Owners already bypass project membership via isCompanyOwner() — this insert
-- is still safe for them (conflict-ignored if they're already members).
INSERT INTO project_members (project_id, company_id, principal_type, principal_id, role, added_by_user_id)
SELECT
    p.id AS project_id,
    p.company_id,
    'user' AS principal_type,
    cm.principal_id,
    'super_admin' AS role,
    NULL AS added_by_user_id
FROM projects p
JOIN company_memberships cm
  ON cm.company_id = p.company_id
 AND cm.principal_type = 'user'
 AND cm.status = 'active'
ON CONFLICT (project_id, principal_type, principal_id) DO NOTHING;
--> statement-breakpoint
-- Grant the full super_admin preset to every backfilled member.
INSERT INTO project_permission_grants (project_id, company_id, principal_type, principal_id, permission_key, granted_by_user_id)
SELECT
    pm.project_id,
    pm.company_id,
    pm.principal_type,
    pm.principal_id,
    perm.key,
    NULL
FROM project_members pm
CROSS JOIN (
    VALUES
        ('project:view'),
        ('project:issues:create'),
        ('project:issues:edit'),
        ('project:issues:delete'),
        ('project:issues:assign'),
        ('project:agents:use'),
        ('project:settings'),
        ('project:members:manage')
) AS perm(key)
WHERE pm.role = 'super_admin'
ON CONFLICT (project_id, principal_type, principal_id, permission_key) DO NOTHING;
