import { pgTable, uuid, jsonb, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * `plugin_config_runtime` table — stores plugin-managed mutable runtime
 * configuration (one row per plugin, enforced by unique index on `plugin_id`).
 *
 * Unlike `plugin_config` (operator-provided, read-only to plugins), this table
 * is written by the plugin worker via `ctx.config.runtime.set/unset`. Operators
 * can inspect and clear it from the instance settings UI.
 *
 * The `revision` column is a monotonically incrementing bigint. It is
 * serialized as an opaque string at the SDK boundary to avoid JS number
 * precision loss (JS number cannot represent the full bigint range).
 *
 * @see PLUGIN_SPEC.md §CC-G3 — ctx.config.runtime
 */
export const pluginConfigRuntime = pgTable(
  "plugin_config_runtime",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdIdx: uniqueIndex("plugin_config_runtime_plugin_id_idx").on(table.pluginId),
  }),
);
