import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * ValAdrien Cloud infra entitlements.
 *
 * One row per (company, capability). Records that a capability is *provided*
 * by the operator pool and, once realized lazily on first use, the reference
 * to the concrete binding (a company secret binding id, a workspace runtime
 * service id, etc.).
 *
 * See doc/plans/2026-06-01-valadrien-cloud-managed-infra.md.
 *
 * - capability: "postgres" | "email" | "llm" | "hosting" | "worker"
 * - mode:       "managed_shared" | "managed_dedicated" | "byo"
 * - status:     "entitled" | "provisioned" | "exported" | "disabled"
 */
export const companyInfraEntitlements = pgTable(
  "company_infra_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    mode: text("mode").notNull().default("managed_shared"),
    status: text("status").notNull().default("entitled"),
    // Upstream provider once known (e.g. "supabase", "resend", "openrouter",
    // "vercel", "railway"). Null until realized.
    provider: text("provider"),
    // Reference to the concrete realized resource (secret binding id, runtime
    // service id, external resource id). Null while still "entitled".
    bindingRef: text("binding_ref"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_infra_entitlements_company_idx").on(table.companyId),
    companyCapabilityUq: uniqueIndex("company_infra_entitlements_company_capability_uq").on(
      table.companyId,
      table.capability,
    ),
  }),
);
