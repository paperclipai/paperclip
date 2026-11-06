WITH added AS (
  INSERT INTO principal_permission_grants (
    company_id, principal_type, principal_id, permission_key, scope
  )
  SELECT agent.company_id, 'agent', agent.id::text, 'agents:read', NULL
  FROM agents AS agent
  JOIN company_memberships AS membership
    ON membership.company_id = agent.company_id
    AND membership.principal_type = 'agent'
    AND membership.principal_id = agent.id::text
    AND membership.status = 'active'
  WHERE agent.status NOT IN ('pending_approval', 'terminated')
    AND agent.lifecycle_state IN ('ready', 'pausing', 'paused', 'resuming')
    AND NOT (agent.lifecycle_holds ? 'setup')
    AND agent.pause_reason IS DISTINCT FROM 'setup'
    AND agent.metadata->'paperclipBuiltInAgent' IS NULL
    AND COALESCE(agent.permissions->>'trustPreset', 'standard') = 'standard'
    AND COALESCE(agent.permissions->'authorizationPolicy'->>'trustPreset', 'standard') = 'standard'
    AND agent.permissions->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
    AND agent.permissions->'authorizationPolicy'->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
    AND agent.permissions->'authorizationPolicy'->'trustBoundary' IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM principal_permission_grants AS existing
      WHERE existing.company_id = agent.company_id
        AND existing.principal_type = 'agent'
        AND existing.principal_id = agent.id::text
        AND existing.permission_key IN ('agents:configure', 'agents:suggest-changes')
        AND existing.scope IS NOT NULL
        AND existing.scope <> '{}'::jsonb
    )
  ON CONFLICT (company_id, principal_type, principal_id, permission_key) DO NOTHING
  RETURNING company_id, principal_id
)
INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
SELECT company_id, 'system', 'migration:agent-config-read-defaults', 'agent.permissions_updated', 'agent', principal_id,
  '{"added":["agents:read"],"source":"migration"}'::jsonb
FROM added;
