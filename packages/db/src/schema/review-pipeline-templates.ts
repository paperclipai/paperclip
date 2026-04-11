import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { teams } from "./teams.js";

export interface ReviewStepConfig {
  slug: string;
  name: string;
  type: "auto" | "manual";
  executor: "codex" | "claude" | "builtin" | "manual";
  config?: Record<string, unknown>;
}

export const reviewPipelineTemplates = pgTable(
  "review_pipeline_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    teamId: uuid("team_id").references(() => teams.id),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    steps: jsonb("steps").$type<ReviewStepConfig[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTeamIdx: index("review_pipeline_templates_company_team_idx").on(
      table.companyId,
      table.teamId,
    ),
  }),
);
