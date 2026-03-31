import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyKnowledge = pgTable(
  "company_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    tier: text("tier").notNull(), // 'global', 'team', 'role'
    targetId: text("target_id"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    alwaysInject: boolean("always_inject").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTierIdx: index("company_knowledge_company_tier_idx").on(table.companyId, table.tier),
  }),
);
