import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agentFolders = pgTable(
  "agent_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => agentFolders.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyParentSlugIdx: uniqueIndex(
      "agent_folders_company_parent_slug_uq",
    ).on(table.companyId, table.parentId, table.slug),
    companyParentNameIdx: uniqueIndex(
      "agent_folders_company_parent_name_uq",
    ).on(table.companyId, table.parentId, table.name),
    companyParentSortIdx: index("agent_folders_company_parent_sort_idx").on(
      table.companyId,
      table.parentId,
      table.sortOrder,
      table.name,
    ),
  }),
);
