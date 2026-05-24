-- Register the `claude_tui` adapter type.
--
-- Note: `agents.adapter_type` is declared as plain `text` (see
-- packages/db/src/schema/agents.ts and migration 0000); there is no
-- Postgres enum or CHECK constraint to extend. The source of truth for
-- the set of known adapter types lives in
-- packages/shared/src/constants.ts (AGENT_ADAPTER_TYPES).
--
-- This migration exists purely to document the addition of `claude_tui`
-- as a first-class adapter, so the migration ledger lines up with the
-- code change that introduced it. It is intentionally a no-op at the
-- database layer.
DO $$
BEGIN
  RAISE NOTICE 'adapter_type ''claude_tui'' registered (no schema change required: agents.adapter_type is free-text)';
END
$$;
