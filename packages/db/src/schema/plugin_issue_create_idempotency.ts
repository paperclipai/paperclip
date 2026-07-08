import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const pluginIssueCreateIdempotency = pgTable(
  "plugin_issue_create_idempotency",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    keyDigest: text("key_digest").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.companyId, table.keyDigest],
      name: "plugin_issue_create_idempotency_pk",
    }),
  }),
);