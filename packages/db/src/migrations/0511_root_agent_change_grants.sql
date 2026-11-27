-- paperclip:migration-compat online_compatible: a one-time INSERT of missing agents:configure and skills:create grants, plus their activity log entries, for the sole root agent of companies that have no root CEO; existing grants are never updated, and the previous release reads the new rows the same way as grants added by an operator.
WITH roots AS (
  SELECT
    agent.*,
    count(*) OVER (PARTITION BY agent.company_id) AS root_count,
    bool_or(lower(btrim(agent.role)) = 'ceo') OVER (PARTITION BY agent.company_id) AS has_ceo_root
  FROM agents AS agent
  WHERE agent.status NOT IN ('pending_approval', 'terminated')
    AND agent.reports_to IS NULL
    AND agent.metadata->'paperclipBuiltInAgent' IS NULL
),
target AS (
  SELECT root.company_id, root.id
  FROM roots AS root
  JOIN company_memberships AS membership
    ON membership.company_id = root.company_id
    AND membership.principal_type = 'agent'
    AND membership.principal_id = root.id::text
    AND membership.status = 'active'
  WHERE root.root_count = 1
    AND NOT root.has_ceo_root
    AND COALESCE(root.permissions->>'trustPreset', 'standard') = 'standard'
    AND COALESCE(root.permissions->'authorizationPolicy'->>'trustPreset', 'standard') = 'standard'
    AND root.permissions->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
    AND root.permissions->'authorizationPolicy'->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
    AND root.permissions->'authorizationPolicy'->'trustBoundary' IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM principal_permission_grants AS existing
      WHERE existing.company_id = root.company_id
        AND existing.principal_type = 'agent'
        AND existing.principal_id = root.id::text
        AND existing.permission_key IN ('agents:configure', 'agents:suggest-changes', 'skills:create', 'skills:suggest-changes')
        AND existing.scope IS NOT NULL
        AND existing.scope <> '{}'::jsonb
    )
),
added AS (
  INSERT INTO principal_permission_grants (
    company_id, principal_type, principal_id, permission_key, scope
  )
  SELECT target.company_id, 'agent', target.id::text, grant_key.permission_key, NULL
  FROM target
  CROSS JOIN (VALUES ('agents:configure'), ('skills:create')) AS grant_key(permission_key)
  ON CONFLICT (company_id, principal_type, principal_id, permission_key) DO NOTHING
  RETURNING company_id, principal_id, permission_key
)
INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
SELECT company_id, 'system', 'migration:root-agent-change-grants', 'agent.permissions_updated', 'agent', principal_id,
  jsonb_build_object('added', jsonb_agg(permission_key ORDER BY permission_key), 'source', 'migration')
FROM added
GROUP BY company_id, principal_id;
