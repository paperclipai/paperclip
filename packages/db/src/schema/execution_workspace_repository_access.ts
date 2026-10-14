import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const executionWorkspaceRepositoryAccess = pgTable("execution_workspace_repository_access", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  rootKey: text("root_key").notNull(),
  canonicalCwd: text("canonical_cwd").notNull(),
  kind: text("kind").$type<"source" | "reader" | "project_source" | "shared_project_source" | "isolated_source" | "isolated_project_source" | "isolated_copy" | "repository">().notNull(),
  scopeId: uuid("scope_id").notNull(),
  issueId: uuid("issue_id"),
  agentId: uuid("agent_id"),
  responsibleUserId: text("responsible_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  scopeIdx: uniqueIndex("execution_workspace_repository_access_scope_idx").on(table.companyId, table.rootKey, table.kind, table.scopeId),
}));
