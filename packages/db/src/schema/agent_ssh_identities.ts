import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentSshIdentities = pgTable(
  "agent_ssh_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    algorithm: text("algorithm").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    fingerprintIdx: index("agent_ssh_identities_fingerprint_idx").on(table.fingerprint),
    agentIdx: index("agent_ssh_identities_agent_id_idx").on(table.agentId),
    companyFingerprintUq: uniqueIndex("agent_ssh_identities_company_fingerprint_uq").on(
      table.companyId,
      table.fingerprint,
    ),
  }),
);
