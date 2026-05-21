UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || '{"silenceSuspicionThresholdMs": 7200000, "silenceCriticalThresholdMs": 21600000}'::jsonb
WHERE id::text LIKE '8cbf489e%';
