import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Optional enrichment, independent of tasks and of provider-specific status vocabularies. */
export const linkPreviews = pgTable("link_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  // Personal provider results must not be reused by another viewer. Empty is local-trusted.
  viewerId: text("viewer_id").notNull(),
  channel: text("channel").notNull(),
  resourceKind: text("resource_kind").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  status: text("status"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => ({
  identity: uniqueIndex("link_previews_scope_url_uq").on(table.companyId, table.viewerId, table.canonicalUrl),
}));
