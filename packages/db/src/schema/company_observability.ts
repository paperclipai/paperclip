import { boolean, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AgentObservabilityCapture, AgentObservabilityDestination, AgentObservabilityTestReceipt } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyObservability = pgTable("company_observability", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  revision: uuid("revision").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  destination: jsonb("destination").$type<AgentObservabilityDestination>().notNull(),
  capture: jsonb("capture").$type<AgentObservabilityCapture>().notNull(),
  credentialsSecretId: uuid("credentials_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  lastTest: jsonb("last_test").$type<AgentObservabilityTestReceipt>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
