import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary"),
    body: text("body"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("knowledge_items_company_created_idx").on(table.companyId, table.createdAt),
    companyKindIdx: index("knowledge_items_company_kind_idx").on(table.companyId, table.kind),
    companyTitleIdx: index("knowledge_items_company_title_idx").on(table.companyId, table.title),
    assetIdx: index("knowledge_items_asset_idx").on(table.assetId),
  }),
);
