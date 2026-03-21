import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { assets } from "./assets.js";
import { agents } from "./agents.js";

export const issueMockups = pgTable(
  "issue_mockups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    version: integer("version").notNull(),
    viewport: text("viewport").notNull().default("desktop"),
    fidelityLevel: text("fidelity_level").notNull().default("high"),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    issueVersionIdx: index("issue_mockups_issue_version_idx").on(
      table.issueId,
      table.version,
    ),
    issueStatusIdx: index("issue_mockups_issue_status_idx").on(
      table.issueId,
      table.status,
    ),
    companyIssueVersionUq: uniqueIndex(
      "issue_mockups_company_issue_version_uq",
    ).on(table.companyId, table.issueId, table.version),
  }),
);
