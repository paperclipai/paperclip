import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    scopeType: text("scope_type").notNull().default("company"),
    scopeId: uuid("scope_id"),
    category: text("category").notNull().default("knowledge"),
    content: text("content").notNull(),
    confidence: doublePrecision("confidence").notNull().default(0.9),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id),
    sourceRunId: uuid("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("memories_company_idx").on(table.companyId),
    companyScopeIdx: index("memories_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
    ),
    companyCategoryIdx: index("memories_company_category_idx").on(
      table.companyId,
      table.category,
    ),
  }),
);
