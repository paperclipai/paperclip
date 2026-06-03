import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_config` table — stores operator-provided plugin configuration.
 *
 * New configuration is company-scoped. Legacy rows may still have a null
 * `company_id` so existing installs keep working until re-saved.
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
    companyId: uuid("company_id")
      .references(() => companies.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdIdx: index("plugin_config_plugin_id_idx").on(table.pluginId),
    companyIdIdx: index("plugin_config_company_id_idx").on(table.companyId),
    legacyPluginIdUq: uniqueIndex("plugin_config_legacy_plugin_id_uq")
      .on(table.pluginId)
      .where(sql`${table.companyId} is null`),
    companyPluginUq: uniqueIndex("plugin_config_company_plugin_uq")
      .on(table.pluginId, table.companyId)
      .where(sql`${table.companyId} is not null`),
  }),
);
