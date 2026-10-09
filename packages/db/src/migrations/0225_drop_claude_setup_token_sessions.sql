-- Drop the old Claude setup-token table. The unified "adapter_auth_sessions"
-- table now holds the Claude setup-token store for both login flows, so the
-- old table has no reader. Migration 0224 moved the columns and the active-slot
-- index onto "adapter_auth_sessions"; this migration removes the dead table.
DROP TABLE IF EXISTS "claude_setup_token_sessions";
