import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import type { FolderKind } from "@paperclipai/shared";

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<FolderKind>().notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    systemKey: text("system_key"),
    color: text("color"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindPositionIdx: index("folders_company_kind_position_idx").on(
      table.companyId,
      table.kind,
      table.position,
      table.name,
    ),
    companyKindRootSlugUniqueIdx: uniqueIndex("folders_company_kind_root_slug_uq")
      .on(table.companyId, table.kind, table.slug)
      .where(sql`${table.parentId} is null`),
    companyKindParentSlugUniqueIdx: uniqueIndex("folders_company_kind_parent_slug_uq")
      .on(table.companyId, table.kind, table.parentId, table.slug)
      .where(sql`${table.parentId} is not null`),
    companyKindSystemKeyUniqueIdx: uniqueIndex("folders_company_kind_system_key_uq")
      .on(table.companyId, table.kind, table.systemKey)
      .where(sql`${table.systemKey} is not null`),
    companyKindParentPositionIdx: index("folders_company_kind_parent_position_idx").on(
      table.companyId,
      table.kind,
      table.parentId,
      table.position,
      table.name,
    ),
  }),
);
