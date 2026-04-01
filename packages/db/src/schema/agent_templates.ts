import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const agentTemplates = pgTable("agent_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  role: text("role").notNull().default("general"),
  title: text("title"),
  icon: text("icon"),
  adapterType: text("adapter_type").notNull().default("claude_local"),
  adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
  systemPrompt: text("system_prompt"),
  skills: jsonb("skills").$type<unknown[]>().notNull().default([]),
  approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
