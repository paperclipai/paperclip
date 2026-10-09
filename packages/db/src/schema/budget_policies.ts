import { sql } from "drizzle-orm";
import { check, boolean, index, integer, pgTable, text, timestamp, uuid, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    metric: text("metric").notNull().default("billed_cents"),
    windowKind: text("window_kind").notNull(),
    amount: integer("amount").notNull().default(0),
    reservationCents: numeric("reservation_cents", { precision: 24, scale: 7 }).notNull().default("0"),
    warnPercent: integer("warn_percent").notNull().default(80),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    unpricedUsagePolicy: text("unpriced_usage_policy").notNull().default("block"),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    enforcementVersion: integer("enforcement_version").notNull().default(0),
    enforcementDeliveredVersion: integer("enforcement_delivered_version").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reservationNonnegative: check("budget_policies_reservation_nonnegative", sql`${table.reservationCents} >= 0`),
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
    companyScopeMetricUniqueIdx: uniqueIndex("budget_policies_company_scope_metric_unique_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.metric,
      table.windowKind,
    ),
  }),
);
