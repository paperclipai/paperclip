import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { formalQaPreparations } from "./formal_qa_preparations.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * Immutable proof that a Formal-QA preparation was materialized as the
 * exact detached Git checkout it named. This is deliberately separate from
 * execution_workspaces: it never creates a runtime, environment lease, run,
 * command, or agent credential.
 */
export const formalQaCheckouts = pgTable(
  "formal_qa_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id")
      .notNull()
      .references(() => formalQaPreparations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id),
    repository: text("repository").notNull(),
    repoRoot: text("repo_root").notNull(),
    checkoutPath: text("checkout_path").notNull(),
    headSha: text("head_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    checkoutSha256: text("checkout_sha256").notNull(),
    status: text("status").notNull().default("verified"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preparationUq: uniqueIndex("formal_qa_checkouts_preparation_uq").on(table.preparationId),
    companyProjectCreatedIdx: index("formal_qa_checkouts_company_project_created_idx")
      .on(table.companyId, table.projectId, table.createdAt),
  }),
);
