import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// A saved task view is a named, reusable *definition* of a task view: the
// filters, sort, grouping, and display options needed to rebuild it. It never
// stores task rows. Opening a saved view re-runs the normal task query, so the
// task table stays the single source of truth and a saved view's contents
// follow task state as it changes.
//
// `viewState` is deliberately opaque to the server. The surface that owns
// `collectionKey` is the only thing that reads it, so the shape can evolve in
// the client without a migration. The server guards ownership and size, not
// filter semantics — those stay in one place, next to the list that applies
// them.
export const userSavedTaskViews = pgTable(
  "user_saved_task_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    collectionKey: text("collection_key").notNull(),
    name: text("name").notNull(),
    viewState: jsonb("view_state").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("user_saved_task_views_owner_idx").on(
      table.companyId,
      table.userId,
      table.collectionKey,
    ),
    ownerNameUq: uniqueIndex("user_saved_task_views_owner_name_uq").on(
      table.companyId,
      table.userId,
      table.collectionKey,
      table.name,
    ),
  }),
);
