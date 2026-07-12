import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One durable row per dispatch scope (e.g. "claude_local/default"). Tracks
 * which owner currently holds the scope's single execution slot and any
 * active provider-quota block, so launch mediation survives process restarts
 * and is never decided from in-memory state alone.
 */
export const dispatchGateState = pgTable("dispatch_gate_state", {
  scopeKey: text("scope_key").primaryKey(),
  ownershipState: text("ownership_state").notNull().default("idle"),
  ownerKind: text("owner_kind"),
  ownerId: text("owner_id"),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  operatorResumeRequired: boolean("operator_resume_required").notNull().default(false),
  blockReason: text("block_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
