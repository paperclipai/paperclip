import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { AdapterAuthSessionInternalStatus, AgentAdapterType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

// The merged state set for the unified login table. One column holds the state
// of both login flows: the device-login flow and the setup-token flow. The set
// joins the two prior state unions into one union. The set drops the dead
// `persisting` state.
//
// The active states hold the company credential slot for one company, owner, and
// adapter. The partial unique index applies to the active states only.
//   - `starting`, `waiting_for_user`, `promoting`: the device-login active states.
//   - `awaiting_code`, `submitting`: the setup-token active states.
// The non-active states do not hold the slot:
//   - `stored`: the one-time setup-token claim. The create path consumes it and
//     writes `bound_at`.
//   - `authenticated`, `completed`: the terminal success states.
//   - `cleanup_pending`: the terminal state whose sandbox delete failed.
//   - `failed`, `timed_out`, `cancelled`: the shared terminal failure states.
export type AdapterAuthSessionState =
  | AdapterAuthSessionInternalStatus
  | "awaiting_code"
  | "submitting"
  | "stored"
  | "completed";

// The active states of the merged set. The partial unique index and the store
// use this list. The list excludes `stored`, every terminal state, and the
// removed `persisting` state.
export const ADAPTER_AUTH_SESSION_ACTIVE_STATES = [
  "starting",
  "waiting_for_user",
  "promoting",
  "awaiting_code",
  "submitting",
] as const satisfies readonly AdapterAuthSessionState[];

// The durable store for an adapter login session. One row tracks one login
// attempt for one adapter in one environment. The row keeps the owner principal,
// the public session id, the provider lease reference, the status, and the
// finish times. The row never stores the prompt, a credential byte, or the raw
// provider secret.
export const adapterAuthSessions = pgTable(
  "adapter_auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").$type<AgentAdapterType>().notNull(),
    // The immutable owner principal. The service sets this column one time at
    // create and never updates it. The service returns the prompt only to this
    // owner. The active-slot index includes this column, so the column stays
    // non-null; a null owner escapes a partial unique index.
    startedByUserId: text("started_by_user_id").notNull(),
    // The opaque public session id. The public API returns this id, and the
    // store keys its lookups by it. The column is non-null, length-bounded, and
    // unique. The store fills it at create with a CSPRNG value.
    publicSessionId: varchar("public_session_id", { length: 128 }).notNull(),
    // The provider lease reference for the sandbox. The reaper reads it to retry
    // a failed sandbox delete. It is not a public field.
    providerLeaseId: text("provider_lease_id"),
    // The merged login state. The column is `text`, so it stores every value of
    // the merged `AdapterAuthSessionState` set. The compile-time `$type` is the
    // merged union, so both login stores share one status type.
    status: text("status").$type<AdapterAuthSessionState>().notNull().default("starting"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // The promotion claim deadline. The service sets this column when it moves the
    // row to `promoting`. While the deadline is in the future, the claim is live,
    // so the reaper does not terminate the session or release the company slot.
    // A null or past deadline means no live claim, so the reaper can reclaim a
    // stalled `promoting` row. The service clears the column on every terminal
    // transition.
    promotionExpiresAt: timestamp("promotion_expires_at", { withTimezone: true }),
    // The claim-consumption marker for a `stored` row. The column is null while
    // the stored claim is live. The create path sets it one time when it consumes
    // the claim. A non-null value marks a consumed claim, so the reaper removes
    // the row. A device-login row never sets this column.
    boundAt: timestamp("bound_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The fixed, non-secret failure code. The public response reads it.
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("adapter_auth_sessions_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    // Serialize on the company credential slot. Only one active session can hold
    // the slot per company, owner, and adapter. The index applies to the active
    // states of the merged set. It does not include the environment; the board
    // rule scopes the slot to the owner, not the environment.
    companyOwnerAdapterActiveUq: uniqueIndex("adapter_auth_sessions_company_owner_adapter_active_uq")
      .on(table.companyId, table.startedByUserId, table.adapterType)
      .where(
        sql`${table.status} IN ('starting', 'waiting_for_user', 'promoting', 'awaiting_code', 'submitting')`,
      ),
    // The public session id is unique across the table. The store keys its
    // lookups by this id.
    publicSessionIdUq: uniqueIndex("adapter_auth_sessions_public_session_id_uq").on(
      table.publicSessionId,
    ),
    environmentIdx: index("adapter_auth_sessions_environment_idx").on(table.environmentId),
    expiresIdx: index("adapter_auth_sessions_expires_idx").on(table.expiresAt),
    providerLeaseIdx: index("adapter_auth_sessions_provider_lease_idx").on(table.providerLeaseId),
  }),
);
