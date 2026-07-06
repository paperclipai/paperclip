-- 0131_plugin_state_unique_with_nulls_not_distinct.sql
--
-- Tighten the plugin_state unique index so that NULL scope_id values are
-- treated as equal by Postgres (NULLS NOT DISTINCT). The Drizzle schema
-- declares the constraint with `.nullsNotDistinct()` (PG 15+), but the
-- migration that created `plugin_state_unique_entry_idx` predates that
-- requirement, so the constraint was created as plain `UNIQUE` and
-- silently treated NULLs as distinct.
--
-- Result of the bug: every `state.set()` on `instance` scope
-- (`scope_id IS NULL`) inserts a fresh row instead of upserting the
-- existing one, because Postgres never reports an `ON CONFLICT` hit
-- when the conflict target contains a NULL column. After a few weeks
-- of plugin activity this leaves thousands of duplicate rows, and the
-- reader (`pluginStateStore.get`) returns whatever row happens to be
-- `rows[0]` — frequently a stale one, so the UI shows old config /
-- scan snapshots and stale `running: true` flags.
--
-- This migration:
--   1. Deduplicates existing rows by keeping the most recent write per
--      (plugin_id, scope_kind, scope_id, namespace, state_key).
--   2. Recreates the constraint with NULLS NOT DISTINCT so future
--      writes upsert correctly.
--
-- Requires Postgres 15+ (NULLS NOT DISTINCT clause).
--
-- Author: MiniMax-M3 (BTCAAAAA-38557 fix-upstream context)
--> statement-breakpoint

-- 1) Dedupe: keep the row with the latest updated_at per logical key.
DELETE FROM "plugin_state" AS a
USING "plugin_state" AS b
WHERE a.ctid <> b.ctid
  AND a."plugin_id" = b."plugin_id"
  AND a."scope_kind" = b."scope_kind"
  AND (a."scope_id" IS NOT DISTINCT FROM b."scope_id")
  AND a."namespace" = b."namespace"
  AND a."state_key" = b."state_key"
  AND a."updated_at" < b."updated_at";
--> statement-breakpoint

-- 2) Drop and re-create the unique constraint with NULLS NOT DISTINCT.
--    IF EXISTS guards make the migration idempotent for databases that
--    already had the fixed constraint applied (e.g. by a previous
--    manual intervention on a development instance).
ALTER TABLE "plugin_state"
  DROP CONSTRAINT IF EXISTS "plugin_state_unique_entry_idx";
--> statement-breakpoint

ALTER TABLE "plugin_state"
  ADD CONSTRAINT "plugin_state_unique_entry_idx"
  UNIQUE NULLS NOT DISTINCT ("plugin_id", "scope_kind", "scope_id", "namespace", "state_key");