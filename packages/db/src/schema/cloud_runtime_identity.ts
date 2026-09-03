import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The one-time Cloud claim identity accepted by this Paperclip instance.
 *
 * This table is deliberately instance-scoped rather than company-scoped: a
 * Paperclip process has exactly one public identity, and a Cloud claim may set
 * it only once. The singleton key makes that invariant enforceable in the
 * database, including across concurrent bootstrap probes.
 */
export const cloudRuntimeIdentity = pgTable("cloud_runtime_identity", {
  singletonKey: text("singleton_key").primaryKey().notNull().default("default"),
  stackId: text("stack_id").notNull(),
  claimId: text("claim_id").notNull(),
  previousOrigin: text("previous_origin").notNull(),
  canonicalOrigin: text("canonical_origin").notNull(),
  stackSlug: text("stack_slug").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
