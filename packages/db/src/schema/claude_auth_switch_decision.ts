import { pgTable, text, boolean, jsonb, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * Audit trail for the smart Claude auth-switch decision engine (TWX-1117 / TWX-1121).
 *
 * One row per hourly decision tick: what the engine decided (switch/hold), from →
 * to, whether it was actually executed (vs. dry-run/shadow), the human rationale,
 * and the ranked usage snapshot at decision time. Stores derived usage only —
 * never OAuth tokens. Append-only; pruned by age out of band if needed.
 */
export const claudeAuthSwitchDecision = pgTable(
  "claude_auth_switch_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    // "switch" | "hold"
    action: text("action").notNull(),
    fromProfile: text("from_profile"),
    toProfile: text("to_profile"),
    targetTier: text("target_tier"),
    /** true when the host switch was actually executed (false = dry-run/shadow or hold). */
    applied: boolean("applied").notNull().default(false),
    reason: text("reason").notNull().default(""),
    /** Ranked candidate snapshot at decision time (ClaudeSwitchCandidate[]). */
    candidates: jsonb("candidates"),
    /** Non-null when execution (or the tick) failed. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decidedAtIdx: index("claude_auth_switch_decision_decided_at_idx").on(table.decidedAt),
  }),
);
