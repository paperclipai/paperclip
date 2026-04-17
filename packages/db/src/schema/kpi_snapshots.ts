import { pgTable, uuid, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const kpiSnapshots = pgTable(
  "kpi_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Lookback window in days (e.g. 7 = last 7 days) */
    windowDays: integer("window_days").notNull().default(7),
    /** JSONB blob of all KPI values at snapshot time */
    kpisJson: jsonb("kpis_json").$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyComputedIdx: index("kpi_snapshots_company_computed_idx").on(
      table.companyId,
      table.computedAt,
    ),
  }),
);
