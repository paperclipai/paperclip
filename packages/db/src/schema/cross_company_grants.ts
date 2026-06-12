import { pgTable, uuid, text, timestamp, jsonb, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const crossCompanyGrants = pgTable(
  "cross_company_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id),
    granteeAgentId: uuid("grantee_agent_id").notNull().references(() => agents.id),
    granteeHomeCompanyId: uuid("grantee_home_company_id").notNull().references(() => companies.id),
    actions: jsonb("actions").$type<string[]>().notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    budgetCapCents: integer("budget_cap_cents"),
    budgetSpentCents: integer("budget_spent_cents").notNull().default(0),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id),
    issuedByUserId: text("issued_by_user_id"),
    issuedByAgentId: uuid("issued_by_agent_id").references(() => agents.id),
    signature: text("signature"),
    signingPublicKey: text("signing_public_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueGranteeTargetIdx: uniqueIndex("cross_company_grants_grantee_target_idx").on(
      table.targetCompanyId,
      table.granteeAgentId,
    ),
    granteeLookupIdx: index("cross_company_grants_grantee_lookup_idx").on(
      table.granteeAgentId,
      table.targetCompanyId,
      table.status,
    ),
  }),
);
