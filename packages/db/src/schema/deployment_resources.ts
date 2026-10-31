import { pgTable, text, uuid, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const deploymentResources = pgTable("deployment_resources", {
  owner: text("owner").notNull(),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  resourceId: uuid("resource_id").notNull(),
  companyId: uuid("company_id"),
  fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
}, (table) => ({
  identity: uniqueIndex("deployment_resources_identity").on(table.owner, table.kind, table.key),
  resource: uniqueIndex("deployment_resources_resource").on(table.kind, table.resourceId),
}));
