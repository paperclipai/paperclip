import { pgTable, uuid, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * account_pool_state — one row per (company, provider) holding the CURRENT account
 * the whole team rides for that provider (load-balancer model). The Balancer Brain
 * cron upserts this row; the credential-injection path reads it at run time to seed
 * the right account.
 *
 * Pool membership itself lives on company_secrets rows marked with
 * providerMetadata.poolType === POOL_ACCOUNT_TYPES[provider] (no schema change to
 * that table). `provider` is "claude" | "codex"; each provider rotates its own pool
 * independently (and `auto_rotation` agents pick the global best across providers).
 */
export const accountPoolState = pgTable(
  "account_pool_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // which provider's pool this row tracks: "claude" | "codex"
    provider: text("provider").notNull().default("claude"),
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
    // whether `auto_rotation` agents may fall back to this machine's local/default
    // login for this provider. Default true. When false the combined-best pick
    // (resolveCombinedBestSeed) skips this provider's default candidate. Does NOT
    // affect the per-provider claude_local/codex_local balancer, which always keeps
    // the local default as its last-resort fallback.
    defaultRotationEnabled: boolean("default_rotation_enabled").notNull().default(true),
    // last-known health snapshot for the machine's LOCAL/default account (the
    // login agents fall back to when activeAccountId is null). Shape matches
    // PoolAccountHealthSnapshot. Persisted by the Balancer so the default card
    // shares the same snapshot pipeline as pooled accounts (no live API on GET).
    defaultHealth: jsonb("default_health").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderUq: uniqueIndex("account_pool_state_company_provider_uq").on(table.companyId, table.provider),
    activeAccountIdx: index("account_pool_state_active_account_idx").on(table.activeAccountId),
  }),
);
