import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * A company-owned pointer to an immutable governance policy revision.  The
 * policy is deliberately independent from agent instruction bundles: replacing
 * an AGENTS.md bundle must never change this row or its revision history.
 */
export const companyGovernancePolicies = pgTable("company_governance_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  activeRevisionId: uuid("active_revision_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyUnique: uniqueIndex("company_governance_policies_company_unique").on(table.companyId),
}));

/**
 * Revision bodies are never updated or deleted by the governance API. Restore
 * creates a new row, preserving the exact revision an earlier run loaded.
 */
export const companyGovernancePolicyRevisions = pgTable("company_governance_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull().references(() => companyGovernancePolicies.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  body: text("body").notNull(),
  bindings: jsonb("bindings").$type<Array<Record<string, unknown>>>().notNull(),
  sha256: text("sha256").notNull(),
  createdByAgentId: uuid("created_by_agent_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  policyRevisionUnique: uniqueIndex("company_governance_policy_revisions_policy_revision_unique").on(
    table.policyId,
    table.revision,
  ),
}));
