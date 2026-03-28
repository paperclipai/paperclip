import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_company_settings` table — stores operator-managed plugin settings
 * scoped to a specific company.
 *
 * This is distinct from `plugin_config`, which stores instance-wide plugin
 * configuration. Each company can have at most one settings row per plugin.
 *
 * Rows represent explicit overrides from the default company behavior:
 * - no row => plugin is enabled for the company by default
 * - row with `enabled = false` => plugin is disabled for that company
 * - row with `enabled = true` => plugin remains enabled and stores company settings
 */
export const pluginCompanySettings = pgTable(
  "plugin_company_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    settingsJson: jsonb("settings_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("plugin_company_settings_company_idx").on(table.companyId),
    pluginIdx: index("plugin_company_settings_plugin_idx").on(table.pluginId),
    companyPluginUq: uniqueIndex("plugin_company_settings_company_plugin_uq").on(
      table.companyId,
      table.pluginId,
    ),
  }),
);
