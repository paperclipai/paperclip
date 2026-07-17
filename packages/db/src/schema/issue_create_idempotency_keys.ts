import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueCreateIdempotencyKeys = pgTable(
  "issue_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("issue_create_idempotency_keys_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    issueIdx: index("issue_create_idempotency_keys_issue_idx").on(table.issueId),
    companyCreatedAtIdx: index("issue_create_idempotency_keys_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
