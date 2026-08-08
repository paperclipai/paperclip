import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { agentOwnershipGrants } from "./agent_ownership_grants.js";
import { companies } from "./companies.js";

/**
 * Two-step ownership transfer / offboarding flow for TECH-4929.
 *
 * Ownership can never be moved by a single write: the current owner (or an
 * instance admin, for break-glass) proposes a transfer to a target user,
 * and the target must accept before the owner grant changes hands. This is
 * also the offboarding path for a departing owner, so it is modeled as a
 * first-class flow rather than a side effect of role management.
 *
 * A row here never determines ownership by itself -- accepting a transfer
 * causes the ownership service to revoke the outgoing owner's row in
 * `agent_ownership_grants` and insert a new one for the incoming owner,
 * linked back to this transfer via `resultingGrantId`.
 */
export const agentOwnershipTransfers = pgTable(
  "agent_ownership_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Deliberately CASCADE -- see the matching comment on
    // agentOwnershipGrants.agentId (agent_ownership_grants.ts): agent hard
    // deletion is a live route (DELETE /agents/:id) and must keep working.
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),

    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),

    // "pending" | "accepted" | "declined" | "cancelled" | "forced"
    // "forced" = instance-admin break-glass override that bypassed
    // acceptance; always paired with an activity-log entry.
    status: text("status").notNull().default("pending"),

    proposedByUserId: text("proposed_by_user_id").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),

    respondedByUserId: text("responded_by_user_id"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),

    // Instance-admin break-glass: who forced it, if anyone.
    forcedByInstanceAdminUserId: text("forced_by_instance_admin_user_id"),

    // The agent_ownership_grants.id created for the new owner once this
    // transfer completes (accepted or forced). SET NULL, not
    // CASCADE/RESTRICT: the referenced grant is for the same agent as this
    // transfer, so it is only ever removed together with this row (via the
    // agentId cascade above); SET NULL just avoids blocking or cascading
    // further in any other scenario. See agentOwnershipGrants
    // .transitionFromGrantId for the same reasoning.
    // FK named explicitly below via `foreignKey({ name: ... })`: Drizzle's
    // auto-generated name for this column/table pair
    // (agent_ownership_transfers_resulting_grant_id_agent_ownership_grants_id_fk,
    // 73 chars) exceeds Postgres's 63-byte identifier limit and would be
    // silently truncated in the catalog.
    resultingGrantId: uuid("resulting_grant_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_ownership_transfers_agent_idx").on(table.agentId),
    companyIdx: index("agent_ownership_transfers_company_idx").on(table.companyId),
    toUserIdx: index("agent_ownership_transfers_to_user_idx").on(table.toUserId, table.status),
    agentStatusIdx: index("agent_ownership_transfers_agent_status_idx").on(table.agentId, table.status),
    // Backs the resultingGrantId FK below. Without it, deleting a grant row
    // (via the agentId cascade off DELETE /agents/:id) does a sequential
    // scan of this append-only, unbounded table to find rows whose
    // resulting_grant_id needs SET NULL.
    resultingGrantIdx: index("agent_ownership_transfers_resulting_grant_id_idx").on(table.resultingGrantId),
    // Named explicitly (short) rather than left to Drizzle's auto-generated
    // name, which would be
    // agent_ownership_transfers_resulting_grant_id_agent_ownership_grants_id_fk
    // (73 chars) -- past Postgres's 63-byte identifier limit, so the
    // catalog name would silently differ from this schema and the
    // migration/snapshot.
    resultingGrantIdFk: foreignKey({
      columns: [table.resultingGrantId],
      foreignColumns: [agentOwnershipGrants.id],
      name: "aot_resulting_grant_id_fk",
    }).onDelete("set null"),
    onePendingPerAgentIdx: uniqueIndex("agent_ownership_transfers_one_pending_idx")
      .on(table.agentId)
      .where(sql`${table.status} = 'pending'`),
    statusCheck: check(
      "agent_ownership_transfers_status_check",
      sql`${table.status} in ('pending', 'accepted', 'declined', 'cancelled', 'forced')`,
    ),
  }),
);
