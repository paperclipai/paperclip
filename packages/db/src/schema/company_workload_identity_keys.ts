import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type CompanyWorkloadIdentityKeyStatus = "next" | "active" | "retiring" | "retired";

/**
 * Signing keys a company's connections use to prove who they are to outside
 * clouds (OIDC workload identity federation). The public half is published;
 * the private half is encrypted with the vault master key and never leaves the
 * control plane. Created lazily, one active key per company.
 */
export const companyWorkloadIdentityKeys = pgTable("company_workload_identity_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  algorithm: text("algorithm").$type<"ES256">().notNull(),
  publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
  privateKeyMaterial: jsonb("private_key_material").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<CompanyWorkloadIdentityKeyStatus>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyKeyUq: uniqueIndex("company_workload_identity_keys_company_key_uq").on(table.companyId, table.keyId),
  oneActiveUq: uniqueIndex("company_workload_identity_keys_one_active_uq")
    .on(table.companyId).where(sql`${table.status} = 'active'`),
  oneNextUq: uniqueIndex("company_workload_identity_keys_one_next_uq")
    .on(table.companyId).where(sql`${table.status} = 'next'`),
  algorithmCheck: check("company_workload_identity_keys_algorithm_check", sql`${table.algorithm} = 'ES256'`),
  statusCheck: check(
    "company_workload_identity_keys_status_check",
    sql`${table.status} in ('next', 'active', 'retiring', 'retired')`,
  ),
}));
