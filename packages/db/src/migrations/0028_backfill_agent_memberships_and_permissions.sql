-- Backfill company_memberships for all agents that don't have one yet.
INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
SELECT company_id, 'agent', id, 'active', 'member'
FROM agents
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Migrate legacy canCreateAgents permission to principal_permission_grants.
INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key)
SELECT company_id, 'agent', id, 'agents:create'
FROM agents
WHERE (permissions->>'canCreateAgents')::boolean = true
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Grant ALL permission keys to CEO agents so role-based bypasses can be removed.
INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key)
SELECT a.company_id, 'agent', a.id, pk.key
FROM agents a
CROSS JOIN (VALUES
  ('agents:create'), ('users:invite'), ('users:manage_permissions'),
  ('tasks:assign'), ('tasks:assign_scope'), ('joins:approve')
) AS pk(key)
WHERE a.role = 'ceo'
ON CONFLICT DO NOTHING;
