import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { cycles } from "./cycles.js";

export const issueCycles = pgTable(
  "issue_cycles",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    cycleId: uuid("cycle_id").notNull().references(() => cycles.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.cycleId], name: "issue_cycles_pk" }),
    issueIdx: index("issue_cycles_issue_idx").on(table.issueId),
    cycleIdx: index("issue_cycles_cycle_idx").on(table.cycleId),
    companyIdx: index("issue_cycles_company_idx").on(table.companyId),
  }),
);
