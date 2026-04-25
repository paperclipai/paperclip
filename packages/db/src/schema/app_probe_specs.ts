import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const appProbeSpecs = pgTable(
  "app_probe_specs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    appName: text("app_name").notNull(),
    probeUrl: text("probe_url").notNull(),
    expectedStatus: integer("expected_status").notNull().default(200),
    bodyRegex: text("body_regex"),
    bodyExcludesRegex: text("body_excludes_regex"),
    smokeEndpoints: text("smoke_endpoints").array(),
    minUptimeSeconds: integer("min_uptime_seconds").notNull().default(30),
    isActive: boolean("is_active").notNull().default(true),
    lastProbedAt: timestamp("last_probed_at", { withTimezone: true }),
    lastProbeResult: text("last_probe_result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAppIdx: index("app_probe_specs_company_app_idx").on(table.companyId, table.appName),
    activeIdx: index("app_probe_specs_active_idx").on(table.isActive),
  }),
);