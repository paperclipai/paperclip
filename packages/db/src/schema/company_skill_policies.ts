import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companySkillPolicies = pgTable("company_skill_policies", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  schemaVersion: integer("schema_version").notNull().default(1),
  revision: integer("revision").notNull(),
  defaultEffect: text("default_effect").$type<"allow" | "deny">().notNull(),
  rules: jsonb("rules").$type<Array<Record<string, unknown>>>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
