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
import { sql } from "drizzle-orm";
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
    // NOTE: doc/types-only — migrations are hand-authored in this repo
    // (drizzle-kit generate is NOT the SSOT), so this block must MIRROR the
    // live DDL in 0228_jac4747_agent_folders.sql exactly; it does not create
    // anything at runtime. Uniqueness is split root vs. child because Postgres
    // treats NULL as distinct, so a single (company, parent_id, slug) unique
    // index would not constrain root folders (parent_id IS NULL).
    companyParentSlugRootIdx: uniqueIndex("agent_folders_company_parent_slug_uq")
      .on(table.companyId, table.parentId, table.slug)
      .where(sql`${table.parentId} IS NULL`),
    companyParentSlugChildIdx: uniqueIndex("agent_folders_company_parent_slug_child_uq")
      .on(table.companyId, table.parentId, table.slug)
      .where(sql`${table.parentId} IS NOT NULL`),
    companyParentNameRootIdx: uniqueIndex("agent_folders_company_parent_name_root_uq")
      .on(table.companyId, table.parentId, table.name)
      .where(sql`${table.parentId} IS NULL`),
    companyParentNameChildIdx: uniqueIndex("agent_folders_company_parent_name_child_uq")
      .on(table.companyId, table.parentId, table.name)
      .where(sql`${table.parentId} IS NOT NULL`),
    companyParentSortIdx: index("agent_folders_company_parent_sort_idx").on(
      table.companyId,
      table.parentId,
      table.sortOrder,
      table.name,
    ),
  }),
);
