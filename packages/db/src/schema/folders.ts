import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { FolderKind } from "@paperclipai/shared";

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<FolderKind>().notNull(),
    name: text("name").notNull(),
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
    companyKindNameUniqueIdx: uniqueIndex("folders_company_kind_name_uq").on(
      table.companyId,
      table.kind,
      table.name,
    ),
  }),
);
