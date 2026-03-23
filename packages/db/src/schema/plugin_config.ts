import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * `plugin_config` table — stores operator-provided instance configuration
 * for each plugin (one row per plugin, enforced by a unique index on
 * `plugin_id`).
 *
 * The `config_json` column holds the values that the operator enters in the
 * plugin settings UI. These values are validated at runtime against the
 * plugin's `instanceConfigSchema` from the manifest.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const pluginConfig = pgTable(
  "plugin_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdIdx: uniqueIndex("plugin_config_plugin_id_idx").on(table.pluginId),
  }),
);
