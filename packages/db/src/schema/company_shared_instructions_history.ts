import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companySharedInstructionsHistory = pgTable(
  "company_shared_instructions_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind").notNull(),
    actorIpOrSource: text("actor_ip_or_source"),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    diffSummary: text("diff_summary"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedAtIdx: index("company_shared_instructions_history_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
