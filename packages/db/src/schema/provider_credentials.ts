import { pgTable, uuid, text, boolean, timestamp, jsonb, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    type: text("type").notNull(),
    credential: jsonb("credential").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    // Auto-rotation bookkeeping. `cooldownUntil` is set when a run using this
    // credential fails in a credential-related way (rate/quota limit, auth
    // failure, or provider rejection); the heartbeat credential picker skips
    // credentials whose cooldown has not yet elapsed. `lastUsedAt` drives
    // least-recently-used selection within a same-type rotation pool.
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    cooldownReason: text("cooldown_reason"),
    // Provider quota is an independent circuit from transient/auth cooldowns.
    // `quotaSampledAt` is a monotonic watermark so a stale response from another
    // replica cannot clear a newer depletion observation.
    quotaCooldownUntil: timestamp("quota_cooldown_until", { withTimezone: true }),
    quotaSampledAt: timestamp("quota_sampled_at", { withTimezone: true }),
    quotaReason: text("quota_reason"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Escalating failover. `consecutiveFailureCount` increments on consecutive
    // failures of the same kind and resets on success/kind change. After auth
    // crosses the disable threshold the credential is parked (`disabledAt` set)
    // so the picker stops wasting runs on a permanently-dead key; the user
    // re-enables it from the Credentials UI (which clears these).
    consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
    lastFailureKind: text("last_failure_kind"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: uniqueIndex("provider_credentials_company_name_idx").on(table.companyId, table.name),
    companyTypeIdx: index("provider_credentials_company_type_idx").on(table.companyId, table.type),
  }),
);
