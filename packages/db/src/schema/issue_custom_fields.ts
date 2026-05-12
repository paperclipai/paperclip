import { pgTable, uuid, text, varchar, numeric, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { plugins } from "./plugins.js";

export const issueCustomFields = pgTable(
  "issue_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    fieldType: text("field_type").notNull(),
    fieldLabel: text("field_label").notNull(),
    valueText: varchar("value_text", { length: 4096 }),
    valueNumber: numeric("value_number"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByPluginId: uuid("deleted_by_plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    liveUniqueIdx: uniqueIndex("issue_custom_fields_live_unique_idx")
      .on(table.companyId, table.issueId, table.pluginId, table.fieldKey)
      .where(sql`${table.deletedAt} IS NULL`),
    issueIdx: index("issue_custom_fields_issue_idx")
      .on(table.companyId, table.issueId)
      .where(sql`${table.deletedAt} IS NULL`),
    pluginIdx: index("issue_custom_fields_plugin_idx")
      .on(table.pluginId)
      .where(sql`${table.deletedAt} IS NULL`),
    numberSortIdx: index("issue_custom_fields_number_sort_idx")
      .on(table.companyId, table.pluginId, table.fieldKey, table.valueNumber)
      .where(sql`${table.deletedAt} IS NULL AND ${table.valueNumber} IS NOT NULL`),
    textSortIdx: index("issue_custom_fields_text_sort_idx")
      .on(table.companyId, table.pluginId, table.fieldKey, table.valueText)
      .where(sql`${table.deletedAt} IS NULL AND ${table.valueText} IS NOT NULL`),
  }),
);
