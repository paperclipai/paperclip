import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentCapabilityDrift = pgTable(
  "agent_capability_drift",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    driftType: text("drift_type").notNull(), // "USED_UNDECLARED" | "DECLARED_UNUSED"
    tool: text("tool").notNull(),
    target: text("target").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentObservedIdx: index("agent_capability_drift_agent_observed_idx").on(table.agentId, table.observedAt),
    companyObservedIdx: index("agent_capability_drift_company_observed_idx").on(table.companyId, table.observedAt),
    runIdx: index("agent_capability_drift_run_idx").on(table.runId),
  }),
);
