import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { artifactFolders } from "./artifact_folders.js";
import { assets } from "./assets.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    folderId: uuid("folder_id").notNull().references(() => artifactFolders.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    mimeType: text("mime_type").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFolderIdx: index("artifacts_company_folder_idx").on(table.companyId, table.folderId),
    companyIssueIdx: index("artifacts_company_issue_idx").on(table.companyId, table.issueId),
    companyAgentIdx: index("artifacts_company_agent_idx").on(table.companyId, table.createdByAgentId),
  }),
);
