import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row lease electing which replica runs the heartbeat/routines
 * scheduler. All lease math uses the DATABASE clock (now()) — client clocks
 * never participate. The row is the source of truth; a leader that cannot
 * renew before expires_at loses leadership (fencing via the renewal
 * predicate), and any candidate may take an expired lease.
 */
export const schedulerLeader = pgTable("scheduler_leader", {
  name: text("name").primaryKey().default("default"),
  leaderId: text("leader_id").notNull(),
  hostname: text("hostname").notNull(),
  electedAt: timestamp("elected_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
