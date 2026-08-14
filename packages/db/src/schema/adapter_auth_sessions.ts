import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AdapterAuthSessionInternalStatus, AgentAdapterType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

// The durable store for an adapter login session. One row tracks one login
// attempt for one adapter in one environment. The row keeps the owner principal,
// the provider lease reference, the status, and the finish times. The row never
// stores the prompt, a credential byte, or the raw provider secret.
export const adapterAuthSessions = pgTable(
  "adapter_auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").$type<AgentAdapterType>().notNull(),
    // The immutable owner principal. The service sets this column one time at
    // create and never updates it. The service returns the prompt only to this
    // owner.
    startedByUserId: text("started_by_user_id").notNull(),
    // The provider lease reference for the sandbox. The reaper reads it to retry
    // a failed sandbox delete. It is not a public field.
    providerLeaseId: text("provider_lease_id"),
    status: text("status").$type<AdapterAuthSessionInternalStatus>().notNull().default("starting"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // The promotion claim deadline. The service sets this column when it moves the
    // row to `promoting`. While the deadline is in the future, the claim is live,
    // so the reaper does not terminate the session or release the company slot.
    // A null or past deadline means no live claim, so the reaper can reclaim a
    // stalled `promoting` row. The service clears the column on every terminal
    // transition.
    promotionExpiresAt: timestamp("promotion_expires_at", { withTimezone: true }),
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
    // the slot per adapter. The index applies to the three active statuses. It
    // does not include the owner or the environment; those stay columns only.
    companyAdapterActiveUq: uniqueIndex("adapter_auth_sessions_company_adapter_active_uq")
      .on(table.companyId, table.adapterType)
      .where(sql`${table.status} IN ('starting', 'waiting_for_user', 'promoting')`),
    environmentIdx: index("adapter_auth_sessions_environment_idx").on(table.environmentId),
    expiresIdx: index("adapter_auth_sessions_expires_idx").on(table.expiresAt),
    providerLeaseIdx: index("adapter_auth_sessions_provider_lease_idx").on(table.providerLeaseId),
  }),
);
