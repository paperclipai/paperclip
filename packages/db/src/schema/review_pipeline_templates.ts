import { pgTable, uuid, text, boolean, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const reviewPipelineTemplates = pgTable(
  "review_pipeline_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    stages: jsonb("stages").notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_review_pipeline_templates_company").on(table.companyId),
  }),
);
