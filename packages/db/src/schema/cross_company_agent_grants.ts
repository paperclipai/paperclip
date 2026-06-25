import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const crossCompanyAgentGrants = pgTable(
  "cross_company_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull().default("agent"),
    principalId: uuid("principal_id").notNull().references(() => agents.id),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id),
    capability: text("capability").notNull(),
    status: text("status").notNull().default("active"),
    // Lifetime / quota controls (TWX-1036). A grant is only exercisable while
    // status = 'active' AND not past expiresAt AND usedCount < maxUses. All three
    // limits are independent and nullable — a null expiresAt / maxUses means "no
    // limit on that axis", preserving the pre-existing unlimited grant behaviour
    // for rows created before this migration.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueTupleIdx: uniqueIndex("cross_company_agent_grants_unique_idx").on(
      table.sourceCompanyId,
      table.principalType,
      table.principalId,
      table.targetCompanyId,
      table.capability,
    ),
    sourcePrincipalStatusIdx: index("cross_company_agent_grants_source_principal_status_idx").on(
      table.sourceCompanyId,
      table.principalType,
      table.principalId,
      table.status,
    ),
    targetStatusIdx: index("cross_company_agent_grants_target_status_idx").on(
      table.targetCompanyId,
      table.status,
    ),
  }),
);
