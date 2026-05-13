import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { legalClients } from "./legal_clients.js";
import { legalMatters } from "./legal_matters.js";

export const legalConflictRecords = pgTable(
  "legal_conflict_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    matterId: uuid("matter_id").references(() => legalMatters.id),
    clientId: uuid("client_id").references(() => legalClients.id),
    conflictType: text("conflict_type").notNull(),
    conflictedPartyName: text("conflicted_party_name").notNull(),
    conflictDescription: text("conflict_description").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("open"),
    detectedByAgentId: uuid("detected_by_agent_id"),
    waivedByUserId: text("waived_by_user_id"),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waiverNote: text("waiver_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("legal_conflict_records_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyMatterIdx: index("legal_conflict_records_company_matter_idx").on(
      table.companyId,
      table.matterId,
    ),
    companyClientIdx: index("legal_conflict_records_company_client_idx").on(
      table.companyId,
      table.clientId,
    ),
  }),
);
