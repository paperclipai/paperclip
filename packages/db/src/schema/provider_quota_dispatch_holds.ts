import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * One durable provider-quota hold per company/provider execution scope.
 *
 * The failed run remains the evidence source. This row is the dispatch
 * projection that lets every agent sharing that provider account stop before
 * it starts another provider process.
 */
export const providerQuotaDispatchHolds = pgTable(
  "provider_quota_dispatch_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    adapterType: text("adapter_type").notNull(),
    provider: text("provider"),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    holdUntil: timestamp("hold_until", { withTimezone: true }).notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyScopeUnique: unique("provider_quota_dispatch_holds_company_scope_uq").on(
      table.companyId,
      table.scopeKey,
    ),
    activeUntilIdx: index("provider_quota_dispatch_holds_active_until_idx")
      .on(table.holdUntil)
      .where(sql`${table.releasedAt} is null`),
  }),
);
