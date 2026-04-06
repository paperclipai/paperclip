import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const sandboxEnvironments = pgTable(
  "sandbox_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    provider: text("provider").notNull().default("e2b"),
    sandboxId: text("sandbox_id"),
    status: text("status").notNull().default("pending"),
    region: text("region").default("us-east-1"),
    template: text("template"),
    timeoutSeconds: integer("timeout_seconds").notNull().default(300),
    cpuMillicores: integer("cpu_millicores").notNull().default(1000),
    memoryMb: integer("memory_mb").notNull().default(512),
    diskMb: integer("disk_mb").notNull().default(1024),
    ports: jsonb("ports").$type<number[]>().default([]),
    envVars: jsonb("env_vars").$type<Record<string, string>>().default({}),
    sandboxUrl: text("sandbox_url"),
    terminalUrl: text("terminal_url"),
    logsUrl: text("logs_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_sandbox_env_company").on(table.companyId),
    agentIdx: index("idx_sandbox_env_agent").on(table.agentId),
    statusIdx: index("idx_sandbox_env_status").on(table.status),
  }),
);
