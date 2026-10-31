import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, foreignKey, check } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentIdentityKeys = pgTable("agent_identity_keys", {
  agentId: uuid("agent_id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  algorithm: text("algorithm").$type<"Ed25519">().notNull(),
  keyId: text("key_id").notNull(),
  publicKeyPem: text("public_key_pem").notNull(),
  privateKeyMaterial: jsonb("private_key_material").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  owner: foreignKey({
    name: "agent_identity_keys_owner_fk",
    columns: [table.companyId, table.agentId],
    foreignColumns: [agents.companyId, agents.id],
  }).onDelete("cascade"),
  algorithmCheck: check("agent_identity_keys_algorithm_check", sql`${table.algorithm} = 'Ed25519'`),
}));
