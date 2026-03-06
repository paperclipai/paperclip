import { pgTable, text, uuid, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const issuePrefixes = pgTable(
  "issue_prefixes",
  {
    prefix: text("prefix").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    counter: integer("counter").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdUniqueIdx: uniqueIndex("issue_prefixes_owner_id_idx").on(table.ownerId),
    ownerLookupIdx: index("issue_prefixes_owner_lookup_idx").on(table.ownerType, table.ownerId),
  }),
);
