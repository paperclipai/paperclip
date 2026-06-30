CREATE INDEX IF NOT EXISTS "plugin_state_gbrain_context_covering_idx"
  ON "plugin_state" ("state_key", "scope_kind", "updated_at", (value_json->>'status'), "scope_id")
  WHERE state_key = 'gbrain-context' AND scope_kind = 'run';
