import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const artifactFolders = pgTable(
  "artifact_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPathUq: uniqueIndex("artifact_folders_company_path_uq").on(table.companyId, table.path),
    companyParentIdx: index("artifact_folders_company_parent_idx").on(table.companyId, table.parentId),
    companySourceIdx: index("artifact_folders_company_source_idx").on(
      table.companyId,
      table.sourceType,
      table.sourceId,
    ),
  }),
);
