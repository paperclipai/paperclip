import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import type { PluginStateScopeKind } from "@paperclipai/shared";
import { plugins } from "./plugins.js";

/**
 * `plugin_state` table — scoped key-value storage for plugin workers.
 *
 * Each row stores a single JSON value identified by
 * `(plugin_id, scope_kind, scope_id, namespace, state_key)`. Plugins use
 * this table through `ctx.state.get()`, `ctx.state.set()`, and
 * `ctx.state.delete()` in the SDK.
 *
 * Scope kinds determine the granularity of isolation:
 * - `instance` — one value shared across the whole Paperclip instance
 * - `company` — one value per company
 * - `project` — one value per project
 * - `project_workspace` — one value per project workspace
 * - `agent` — one value per agent
 * - `issue` — one value per issue
 * - `goal` — one value per goal
 * - `run` — one value per agent run
 *
 * The `namespace` column defaults to `"default"` and can be used to
 * logically group keys without polluting the root namespace.
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state`
 */
export const pluginState = pgTable(
  "plugin_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Granularity of the scope (e.g. `"instance"`, `"project"`, `"issue"`). */
    scopeKind: text("scope_kind").$type<PluginStateScopeKind>().notNull(),
    /**
     * UUID or text identifier for the scoped object.
     * Null for `instance` scope (which has no associated entity).
     */
    scopeId: text("scope_id"),
    /**
     * Sub-namespace to avoid key collisions within a scope.
     * Defaults to `"default"` if the plugin does not specify one.
     */
    namespace: text("namespace").notNull().default("default"),
    /** The key identifying this state entry within the namespace. */
    stateKey: text("state_key").notNull(),
    /** JSON-serializable value stored by the plugin. */
    valueJson: jsonb("value_json").notNull(),
    /** Timestamp of the most recent write. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * Unique constraint enforces that there is at most one value per
     * (plugin, scope kind, scope id, namespace, key) tuple.
     *
     * `nullsNotDistinct()` is required so that `scope_id IS NULL` entries
     * (used by `instance` scope) are treated as equal by PostgreSQL rather
     * than as distinct nulls — otherwise the upsert target in `set()` would
     * fail to match existing rows and create duplicates.
     *
     * Requires PostgreSQL 15+.
     */
    uniqueEntry: unique("plugin_state_unique_entry_idx")
      .on(
        table.pluginId,
        table.scopeKind,
        table.scopeId,
        table.namespace,
        table.stateKey,
      )
      .nullsNotDistinct(),
    /** Speed up lookups by plugin + scope kind (most common access pattern). */
    pluginScopeIdx: index("plugin_state_plugin_scope_idx").on(
      table.pluginId,
      table.scopeKind,
    ),
  }),
);
