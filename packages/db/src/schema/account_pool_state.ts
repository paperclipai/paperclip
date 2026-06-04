import { pgTable, uuid, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * account_pool_state — one row per company holding the CURRENT account the whole
 * team rides (load-balancer model). The Balancer Brain cron upserts this row; the
 * credential-injection path reads it at run time to seed the right account.
 *
 * Pool membership itself lives on company_secrets rows marked with
 * providerMetadata.poolType === "claude_account" (no schema change to that table).
 */
export const accountPoolState = pgTable(
  "account_pool_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // the secret (pooled account) the team is currently authenticated as
    activeAccountId: uuid("active_account_id").references(() => companySecrets.id, { onDelete: "set null" }),
    // previous account, kept for audit / "last rotation" display
    prevAccountId: uuid("prev_account_id").references(() => companySecrets.id, { onDelete: "set null" }),
    // "initial" | "rotation" | "manual"
    reason: text("reason").notNull().default("initial"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    // global STOP switch (D3) — when true the Balancer must not auto-rotate
    rotationStopped: boolean("rotation_stopped").notNull().default(false),
    stopReason: text("stop_reason"),
    // last-known health snapshot for the machine's LOCAL/default account (the
    // login agents fall back to when activeAccountId is null). Shape matches
    // PoolAccountHealthSnapshot. Persisted by the Balancer so the default card
    // shares the same snapshot pipeline as pooled accounts (no live API on GET).
    defaultHealth: jsonb("default_health").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("account_pool_state_company_uq").on(table.companyId),
    activeAccountIdx: index("account_pool_state_active_account_idx").on(table.activeAccountId),
  }),
);
