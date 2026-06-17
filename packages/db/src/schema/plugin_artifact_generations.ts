import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Append-only ledger of plugin-tree snapshots in object storage. The
 * generation number is the CAS: publishers insert max+1 with a PK conflict
 * retry, so exactly one writer wins each generation. Replicas converge to
 * max(generation). Pruned alongside snapshot GC (keep last 3).
 */
export const pluginArtifactGenerations = pgTable("plugin_artifact_generations", {
  generation: bigint("generation", { mode: "number" }).primaryKey(),
  storageKey: text("storage_key").notNull(),
  contentHash: text("content_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
