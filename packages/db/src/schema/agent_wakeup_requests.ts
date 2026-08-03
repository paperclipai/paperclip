import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Wake statuses in which a request still represents a wake that took effect,
 * so a second request carrying the same idempotency key must not create a
 * second run.
 *
 * Deliberately excludes every status that means "this wake did NOT happen"
 * (`skipped`, `coalesced`, `failed`, `cancelled`): suppressing a later wake
 * because an earlier one was skipped would silently drop work, which is a
 * worse failure than an occasional duplicate run.
 */
export const IDEMPOTENT_AGENT_WAKEUP_STATUSES = [
  "queued",
  "claimed",
  "deferred_issue_execution",
  "completed",
] as const;

export type IdempotentAgentWakeupStatus = (typeof IDEMPOTENT_AGENT_WAKEUP_STATUSES)[number];

const idempotentStatusList = sql.raw(
  IDEMPOTENT_AGENT_WAKEUP_STATUSES.map((status) => `'${status}'`).join(", "),
);

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    // Makes the idempotency key enforceable instead of decorative: the enqueue
    // path checks for a live wake with the same key first, and this index wins
    // the race the check cannot see (two concurrent enqueues both missing the
    // other's uncommitted row).
    companyIdempotencyKeyUq: uniqueIndex("agent_wakeup_requests_company_idempotency_key_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null and ${table.status} in (${idempotentStatusList})`),
  }),
);
