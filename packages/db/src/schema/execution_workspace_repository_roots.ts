import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const executionWorkspaceRepositoryRoots = pgTable("execution_workspace_repository_roots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  canonicalCwd: text("canonical_cwd").notNull(),
  rootKey: text("root_key").notNull(),
  mode: text("mode").$type<"anonymous_only" | "managed">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  rootIdx: uniqueIndex("execution_workspace_repository_roots_company_root_idx").on(table.companyId, table.rootKey),
}));
