import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, bigint, jsonb, index, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// 1:1 sidecar to a plan-root issue (issues.workMode = 'planning').
// The plan root stays an issue so assignment/heartbeat/comments/docs/tree-holds
// all work for free; this table holds the plan-specific lifecycle + tier structure
// + budget caps that do not fit the issue 7-status enum.
export const planDetails = pgTable(
  "plan_details",
  {
    issueId: uuid("issue_id")
      .primaryKey()
      .references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Plan lifecycle, independent of the root issue status.
    state: text("state").notNull().default("draft"),
    // Ordered tiers: [{ id, kind: 'phase'|'wave', name, requestedChildren: [...], childIssueIds: [] }]
    tiers: jsonb("tiers").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    budgetCapCents: integer("budget_cap_cents"),
    budgetCapTokens: bigint("budget_cap_tokens", { mode: "number" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStateIdx: index("plan_details_company_state_idx").on(table.companyId, table.state),
  }),
);
