import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config")
      .$type<{
        github?: {
          owner: string;
          repo: string;
          baseBranch: string;
          webhookSecret?: string;
        };
        deploy?: {
          url?: string;
          healthEndpoint?: string;
        };
        merge?: {
          method?: "squash" | "merge" | "rebase";
          deleteSourceBranch?: boolean;
        };
      }>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_environments_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
  }),
);
