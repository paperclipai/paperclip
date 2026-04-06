import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { deployments } from "./deployments.js";

export const deploymentHealthChecks = pgTable(
  "deployment_health_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").notNull().default("unknown"),
    responseTimeMs: integer("response_time_ms"),
    statusCode: integer("status_code"),
    message: text("message"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deploymentIdx: index("idx_deployment_health_checks_deployment").on(table.deploymentId),
    companyIdx: index("idx_deployment_health_checks_company").on(table.companyId),
  }),
);
