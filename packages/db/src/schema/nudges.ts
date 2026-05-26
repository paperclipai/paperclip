import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const nudges = pgTable(
  "nudges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorAgentId: uuid("actor_agent_id").notNull().references(() => agents.id),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id),
    targetAssigneeAgentId: uuid("target_assignee_agent_id").references(() => agents.id),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason").notNull(),
    woke: boolean("woke").notNull().default(false),
    rateLimited: boolean("rate_limited").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique per (company, actor, idempotency-key) so different agents using
    // the same key value (e.g. nudge:{issueId}:{actorAgentId}:{date}) do not
    // collide and one actor cannot squat another's slot.
    companyActorIdempotencyUq: uniqueIndex("nudges_company_actor_idempotency_uq").on(
      table.companyId,
      table.actorAgentId,
      table.idempotencyKey,
    ),
    actorCreatedIdx: index("nudges_actor_created_idx").on(
      table.companyId,
      table.actorAgentId,
      table.createdAt,
    ),
    targetIssueIdx: index("nudges_target_issue_idx").on(table.targetIssueId),
  }),
);
