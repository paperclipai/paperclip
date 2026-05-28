import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentDelegateGrants = pgTable(
  "agent_delegate_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostCompanyId: uuid("host_company_id").notNull().references(() => companies.id),
    delegateAgentId: uuid("delegate_agent_id").notNull().references(() => agents.id),
    // Not a FK — denormalised at grant time; delegate may live in a remote company.
    delegateCompanyId: uuid("delegate_company_id").notNull(),
    scopes: text("scopes").array().notNull().default(["read", "write"]),
    grantedByUserId: text("granted_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    // Retention: rows are purge-eligible 90 days after revocation. Computed by DB.
    cleanupEligibleAt: timestamp("cleanup_eligible_at", { withTimezone: true })
      .generatedAlwaysAs(sql`revoked_at + INTERVAL '90 days'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial unique: at most one active (non-revoked) grant per host+delegate pair.
    activeHostDelegateUq: uniqueIndex("agent_delegate_grants_active_host_delegate_uq")
      .on(table.hostCompanyId, table.delegateAgentId)
      .where(sql`${table.revokedAt} IS NULL`),
    delegateAgentIdx: index("agent_delegate_grants_delegate_agent_idx")
      .on(table.delegateAgentId),
    hostCreatedIdx: index("agent_delegate_grants_host_created_idx")
      .on(table.hostCompanyId, table.createdAt),
  }),
);
