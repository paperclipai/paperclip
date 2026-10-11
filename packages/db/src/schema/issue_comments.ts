import type {
  IssueCommentAuthorType,
  IssueCommentAuthSource,
  IssueCommentDerivedAuthorSource,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { pgTable, uuid, text, timestamp, index, jsonb, unique, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { authUsers } from "./auth.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    onBehalfOfUserId: text("on_behalf_of_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    // How the request that created this comment authenticated (session / board_key /
    // local_implicit / cloud_tenant / agent_key / agent_jwt). `createdByRunId` alone cannot
    // tell a genuine interactive human reply apart from a board-API-key-authenticated script
    // posting as the same user — this column is that missing signal. Null on rows
    // written before this column existed; those are deliberately NOT treated as "session" by
    // the supersede gate, since their true source is unknown.
    authSource: text("auth_source").$type<IssueCommentAuthSource>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Persisted result of best-effort agent-attribution derivation for comments
    // authored by a non-human sentinel (e.g. `local-board`). Populated once by a
    // backfill migration and lazily on read so the load path stops re-scanning
    // run logs.
    derivedAuthorAgentId: uuid("derived_author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    derivedCreatedByRunId: uuid("derived_created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    derivedAuthorSource: text("derived_author_source").$type<IssueCommentDerivedAuthorSource>(),
    clientRequestId: text("client_request_id"),
    conversationSessionGeneration: integer("conversation_session_generation"),
    origin: text("origin").$type<"comment" | "fast_response">().notNull().default("comment"),
    fastResponseRequestId: uuid("fast_response_request_id"),
    body: text("body").notNull(),
    presentation: jsonb("presentation").$type<IssueCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<IssueCommentMetadata | null>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByType: text("deleted_by_type").$type<"agent" | "user">(),
    deletedByAgentId: uuid("deleted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    deletedByUserId: text("deleted_by_user_id"),
    deletedByRunId: uuid("deleted_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientRequestUq: unique("issue_comments_client_request_uq").on(table.issueId, table.authorUserId, table.clientRequestId),
    companyIdUq: unique("issue_comments_company_id_uq").on(table.companyId, table.id),
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    companyIdx: index("issue_comments_company_idx").on(table.companyId),
    companyIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
    bodySearchIdx: index("issue_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
  }),
);
