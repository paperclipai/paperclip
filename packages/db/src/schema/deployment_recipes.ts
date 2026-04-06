import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const deploymentRecipes = pgTable(
  "deployment_recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    cloudProvider: text("cloud_provider").notNull(),
    cloudRegion: text("cloud_region").notNull().default("us-east-1"),
    resourceType: text("resource_type").notNull(),
    configTemplate: jsonb("config_template").$type<Record<string, unknown>>().notNull().default({}),
    envTemplate: jsonb("env_template").$type<Record<string, string>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_deployment_recipes_company").on(table.companyId),
  }),
);
