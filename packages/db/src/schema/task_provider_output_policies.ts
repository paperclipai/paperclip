import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const taskProviderOutputPolicies = pgTable(
  "task_provider_output_policies",
  {
    issueId: uuid("issue_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    disposition: text("disposition").$type<"ordinary" | "forbidden">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "task_provider_output_policies_issue_fk",
    }).onDelete("cascade"),
    dispositionCheck: check(
      "task_provider_output_policies_disposition_check",
      sql`${table.disposition} in ('ordinary', 'forbidden')`,
    ),
  }),
);
