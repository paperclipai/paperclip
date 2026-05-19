import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const pluginManagedResources = pgTable(
  "plugin_managed_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceKey: text("resource_key").notNull(),
    resourceId: uuid("resource_id").notNull(),
    defaultsJson: jsonb("defaults_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("plugin_managed_resources_company_idx").on(table.companyId),
    pluginIdx: index("plugin_managed_resources_plugin_idx").on(table.pluginId),
    resourceIdx: index("plugin_managed_resources_resource_idx").on(table.resourceKind, table.resourceId),
    companyPluginResourceUq: uniqueIndex("plugin_managed_resources_company_plugin_resource_uq").on(
      table.companyId,
      table.pluginId,
      table.resourceKind,
      table.resourceKey,
    ),
  }),
);
