-- Native Codex, OpenCode and Claude agents stored lifecycleMode = 'per_turn'
-- because agent creation wrote the old default. Clear it so the agent follows
-- the product default (warm for local Codex and OpenCode; per-turn elsewhere,
-- including Claude and remote targets). Skip any agent whose configuration
-- history shows an explicit change to 'per_turn' ("Turn by turn"). Creation
-- records no revision, so a choice made at creation cannot be told apart from
-- the old default. Each migrated agent gets an auditable, reversible activity
-- entry; "Turn by turn" stays available in the agent's Runner lifecycle field.
WITH explicit_per_turn AS (
  SELECT DISTINCT revision.agent_id
  FROM agent_config_revisions AS revision
  WHERE revision.after_config->'adapterConfig'->>'lifecycleMode' = 'per_turn'
    AND (revision.before_config->'adapterConfig'->>'lifecycleMode') IS DISTINCT FROM 'per_turn'
),
migrated AS (
  UPDATE agents AS agent
  SET adapter_config = agent.adapter_config - 'lifecycleMode',
      updated_at = now()
  WHERE agent.adapter_type = 'paperclip_runner'
    AND agent.adapter_config->>'lifecycleMode' = 'per_turn'
    AND (
      agent.adapter_config->>'provider' IN ('codex', 'opencode')
      OR (agent.adapter_config->>'provider' = 'acpx' AND agent.adapter_config->>'acpxAgent' = 'claude')
    )
    AND NOT EXISTS (SELECT 1 FROM explicit_per_turn WHERE explicit_per_turn.agent_id = agent.id)
  RETURNING agent.company_id, agent.id
)
INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
SELECT company_id, 'system', 'migration:native-warm-follow-up-default', 'agent.updated', 'agent', id::text,
  '{"source":"migration","changedKeys":["adapterConfig.lifecycleMode"],"before":{"lifecycleMode":"per_turn"},"after":{"lifecycleMode":null},"reason":"The stored per_turn was the old creation default; the agent now follows the product lifecycle default. Choose Turn by turn in the Runner lifecycle field to restore it."}'::jsonb
FROM migrated;
