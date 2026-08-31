WITH migrated_agents AS (
  SELECT
    "id",
    "company_id",
    CASE lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude'))
      WHEN 'codex' THEN 'codex_local'
      ELSE 'claude_local'
    END AS "next_adapter_type",
    CASE lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude'))
      WHEN 'codex' THEN
        (
          "adapter_config"
            - 'agent'
            - 'effort'
            - 'reasoningEffort'
            - 'thinkingEffort'
        )
        || jsonb_build_object('engine', 'acp')
        || CASE
          WHEN COALESCE(
            "adapter_config" -> 'modelReasoningEffort',
            "adapter_config" -> 'reasoningEffort',
            "adapter_config" -> 'thinkingEffort',
            "adapter_config" -> 'effort'
          ) IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'modelReasoningEffort',
            COALESCE(
              "adapter_config" -> 'modelReasoningEffort',
              "adapter_config" -> 'reasoningEffort',
              "adapter_config" -> 'thinkingEffort',
              "adapter_config" -> 'effort'
            )
          )
        END
      ELSE
        (
          "adapter_config"
            - 'agent'
            - 'modelReasoningEffort'
            - 'reasoningEffort'
            - 'thinkingEffort'
        )
        || jsonb_build_object('engine', 'acp')
        || CASE
          WHEN COALESCE(
            "adapter_config" -> 'effort',
            "adapter_config" -> 'thinkingEffort',
            "adapter_config" -> 'reasoningEffort',
            "adapter_config" -> 'modelReasoningEffort'
          ) IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'effort',
            COALESCE(
              "adapter_config" -> 'effort',
              "adapter_config" -> 'thinkingEffort',
              "adapter_config" -> 'reasoningEffort',
              "adapter_config" -> 'modelReasoningEffort'
            )
          )
        END
    END AS "next_adapter_config"
  FROM "agents"
  WHERE "adapter_type" = 'acpx_local'
    AND lower(COALESCE(NULLIF("adapter_config" ->> 'agent', ''), 'claude')) IN ('claude', 'codex')
),
updated_agents AS (
  UPDATE "agents"
  SET
    "adapter_type" = migrated_agents."next_adapter_type",
    "adapter_config" = migrated_agents."next_adapter_config",
    "updated_at" = now()
  FROM migrated_agents
  WHERE "agents"."id" = migrated_agents."id"
  RETURNING
    "agents"."id",
    "agents"."company_id",
    migrated_agents."next_adapter_type"
),
cleared_task_sessions AS (
  DELETE FROM "agent_task_sessions"
  USING updated_agents
  WHERE "agent_task_sessions"."agent_id" = updated_agents."id"
    AND "agent_task_sessions"."company_id" = updated_agents."company_id"
    AND "agent_task_sessions"."adapter_type" = 'acpx_local'
  RETURNING "agent_task_sessions"."id"
)
UPDATE "agent_runtime_state"
SET
  "adapter_type" = updated_agents."next_adapter_type",
  "session_id" = NULL,
  "state_json" = '{}'::jsonb,
  "last_error" = NULL,
  "updated_at" = now()
FROM updated_agents
WHERE "agent_runtime_state"."agent_id" = updated_agents."id"
  AND "agent_runtime_state"."company_id" = updated_agents."company_id";
