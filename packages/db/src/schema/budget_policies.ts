import { boolean, index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    adapterName: text("adapter_name"),
    metric: text("metric").notNull().default("billed_cents"),
    windowKind: text("window_kind").notNull(),
    amount: integer("amount").notNull().default(0),
    warnPercent: integer("warn_percent").notNull().default(60),
    warnHighPercent: integer("warn_high_percent").notNull().default(85),
    warnRecoveryPercent: integer("warn_recovery_percent").notNull().default(55),
    warnHighRecoveryPercent: integer("warn_high_recovery_percent").notNull().default(75),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeActiveIdx: index("budget_policies_company_scope_active_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.isActive,
    ),
    companyWindowIdx: index("budget_policies_company_window_idx").on(
      table.companyId,
      table.windowKind,
      table.metric,
    ),
    // Partial unique index for non-adapter policies (adapter_name IS NULL)
    companyScopeMetricUniqueIdx: uniqueIndex("budget_policies_company_scope_metric_unique_idx")
      .on(table.companyId, table.scopeType, table.scopeId, table.metric, table.windowKind)
      .where(sql`${table.adapterName} IS NULL`),
    // Partial unique index for adapter-type policies
    adapterMetricUniqueIdx: uniqueIndex("budget_policies_adapter_metric_unique_idx")
      .on(table.companyId, table.adapterName, table.metric, table.windowKind)
      .where(sql`${table.scopeType} = 'adapter'`),
  }),
);
