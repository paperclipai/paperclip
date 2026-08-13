import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AgentAdapterType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

/**
 * The durable state of one Claude setup-token cleanup record. The store never
 * reuses `adapter_auth_sessions`; this table is a dedicated, non-secret cleanup
 * store. The active states hold a live login. The `stored` state marks a session
 * that wrote the owner-bound secret and now persists as a one-time claim. The
 * create path consumes the claim by setting `bound_at`. The reaper removes the
 * row after `deadline_at`. The terminal states end the login.
 */
export type ClaudeSetupTokenSessionState =
  | "starting"
  | "awaiting_code"
  | "submitting"
  | "persisting"
  | "stored"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

// The active states hold the company credential slot. The partial unique index
// applies to these states only. It does not include `stored` or a terminal
// state, so a stored claim and a terminal record do not block a new login.
export const CLAUDE_SETUP_TOKEN_ACTIVE_STATES = [
  "starting",
  "awaiting_code",
  "submitting",
  "persisting",
] as const satisfies readonly ClaudeSetupTokenSessionState[];

// The durable store for one Claude setup-token cleanup record. One row tracks
// one login for one owner, one adapter, and one environment. The row keeps only
// ids, the state, the sandbox lease reference, and the deadlines. The row never
// holds the login URL, the browser code, the token, or a process chunk.
export const claudeSetupTokenSessions = pgTable(
  "claude_setup_token_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque service session id. The store keys every update by this id.
    sessionId: text("session_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // The immutable owner principal. The service sets this column one time at
    // create and never updates it.
    ownerUserId: text("owner_user_id").notNull(),
    adapterType: text("adapter_type").$type<AgentAdapterType>().notNull(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    // The provider lease reference for the sandbox. The reaper reads it to
    // release a lease that a crash or a failure left behind. It is not a secret.
    leaseId: text("lease_id"),
    state: text("state").$type<ClaudeSetupTokenSessionState>().notNull().default("starting"),
    // The login deadline. The reaper removes the row after this time. The
    // claim-consumption write also checks this column with `clock_timestamp()`.
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    // The claim-consumption marker. It is null while the stored claim is live.
    // The create path sets it one time when it consumes the claim. A non-null
    // value marks a consumed claim, so the reaper removes the row.
    boundAt: timestamp("bound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Serialize the active login on the full owner scope. Only one active
    // session can run per company, owner, adapter, and environment. The index
    // applies to the active states only; it excludes `stored` and every terminal
    // state, so a stored claim and a terminal record never block a new login.
    activeUq: uniqueIndex("claude_setup_token_sessions_active_uq")
      .on(table.companyId, table.ownerUserId, table.adapterType, table.environmentId)
      .where(sql`${table.state} IN ('starting', 'awaiting_code', 'submitting', 'persisting')`),
    // The store keys every update by the opaque session id, so it stays unique.
    sessionIdUq: uniqueIndex("claude_setup_token_sessions_session_id_uq").on(table.sessionId),
    // The reaper scans by the deadline to remove an expired record.
    deadlineIdx: index("claude_setup_token_sessions_deadline_idx").on(table.deadlineAt),
  }),
);
