import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { legalClients } from "./legal_clients.js";

export const legalMatters = pgTable(
  "legal_matters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    clientId: uuid("client_id").references(() => legalClients.id),
    title: text("title").notNull(),
    matterType: text("matter_type").notNull(),
    practiceArea: text("practice_area").notNull(),
    status: text("status").notNull().default("open"),
    privilegeRing: text("privilege_ring").notNull().default("attorney-client"),
    summary: text("summary"),
    profileKey: text("profile_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    openedByUserId: text("opened_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusPracticeAreaIdx: index(
      "legal_matters_company_status_practice_area_idx",
    ).on(table.companyId, table.status, table.practiceArea),
    companyClientIdx: index("legal_matters_company_client_idx").on(
      table.companyId,
      table.clientId,
    ),
  }),
);
