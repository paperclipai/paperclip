import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const externalLinks = pgTable(
  "external_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    externalKey: text("external_key").notNull(),
    externalUrl: text("external_url").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("external_links_issue_idx").on(table.issueId),
    reverseIdx: index("external_links_reverse_idx").on(table.platform, table.externalKey),
    uniqueLink: uniqueIndex("external_links_issue_platform_key_uq").on(
      table.issueId,
      table.platform,
      table.externalKey,
    ),
  }),
);
