import { pgTable, uuid, text, timestamp, bigint, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/**
 * A board-approved permission for one specific task to cross the >=1M raw-input
 * token guard. The exception is deliberately narrow and self-documenting: it
 * names the task (`issueId`), the cap it authorizes (`capTokens`), why it
 * exists (`reason`), and when it lapses (`expiresAt`). A run may only exceed the
 * >=1M ceiling while an unrevoked, unexpired exception whose cap covers the run
 * exists for its task; otherwise the high-input-token guard blocks as usual.
 *
 * `agentId` optionally scopes the exception to a single agent on the task; when
 * null the exception applies to any agent executing the issue.
 */
export const boardTokenExceptions = pgTable(
  "board_token_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    agentId: uuid("agent_id").references(() => agents.id),
    capTokens: bigint("cap_tokens", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    revokedByAgentId: uuid("revoked_by_agent_id").references(() => agents.id),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("board_token_exceptions_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
  }),
);
