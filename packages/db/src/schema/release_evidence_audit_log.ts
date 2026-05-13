import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const releaseEvidenceAuditLog = pgTable(
  "release_evidence_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    kind: text("kind").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    githubApiCalled: boolean("github_api_called").notNull().default(false),
    degraded: boolean("degraded").notNull().default(false),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("release_evidence_audit_log_issue_idx").on(table.issueId),
    createdAtIdx: index("release_evidence_audit_log_created_at_idx").on(table.createdAt),
    outcomeIdx: index("release_evidence_audit_log_outcome_idx").on(table.outcome, table.createdAt),
  }),
);
