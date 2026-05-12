import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentCoverageGaps = pgTable(
  "agent_coverage_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    gapType: text("gap_type").notNull(), // "SILENT_HEARTBEAT" | "SILENT_ASSIGNED" | "SQS_NO_RUN"
    detail: text("detail").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastFlaggedAt: timestamp("last_flagged_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    agentGapIdx: index("agent_coverage_gaps_agent_gap_idx").on(table.agentId, table.gapType),
    companyObservedIdx: index("agent_coverage_gaps_company_observed_idx").on(table.companyId, table.observedAt),
    unresolvedIdx: index("agent_coverage_gaps_unresolved_idx").on(table.agentId, table.resolvedAt),
  }),
);
