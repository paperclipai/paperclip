import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const legalClients = pgTable(
  "legal_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    externalRef: text("external_ref"),
    primaryContact: jsonb("primary_contact").$type<{
      name?: string;
      email?: string;
      phone?: string;
      title?: string;
    } | null>(),
    status: text("status").notNull().default("active"),
    conflictsCheckedAt: timestamp("conflicts_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("legal_clients_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyNameIdx: index("legal_clients_company_name_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);
