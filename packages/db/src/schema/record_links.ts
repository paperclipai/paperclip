import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const recordLinks = pgTable(
  "record_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerKind: text("owner_kind").notNull(),
    ownerId: uuid("owner_id").notNull(),
    recordKind: text("record_kind").notNull(),
    recordId: text("record_id").notNull(),
    role: text("role"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOwnerIdx: index("record_links_company_owner_idx").on(table.companyId, table.ownerKind, table.ownerId),
    companyRecordIdx: index("record_links_company_record_idx").on(table.companyId, table.recordKind, table.recordId),
    ownerRecordUq: uniqueIndex("record_links_owner_record_uq").on(
      table.companyId,
      table.ownerKind,
      table.ownerId,
      table.recordKind,
      table.recordId,
    ),
  }),
);
