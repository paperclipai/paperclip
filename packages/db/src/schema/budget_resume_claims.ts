import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { budgetIncidents } from "./budget_incidents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * A run a budget stop cancelled, owed one continuation because a board member
 * resolved the incident with Raise budget and resume. Kept outside the run's
 * result JSON, which terminal writers replace, so a Stop that settles at the
 * same moment cannot erase it.
 */
export const budgetResumeClaims = pgTable(
  "budget_resume_claims",
  {
    runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id").notNull().references(() => budgetIncidents.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    actorSource: text("actor_source"),
    state: text("state").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    reason: text("reason"),
    requestId: uuid("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pendingIdx: index("budget_resume_claims_pending_idx").on(table.companyId, table.runId)
      .where(sql`${table.state} = 'pending'`),
  }),
);
