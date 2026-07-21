import type {
  IssueCommentAuthorType,
  IssueCommentDerivedAuthorSource,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Persisted result of best-effort agent-attribution derivation for comments
    // authored by a non-human sentinel (e.g. `local-board`). Populated once by a
    // backfill migration and lazily on read so the load path stops re-scanning
    // run logs.
    derivedAuthorAgentId: uuid("derived_author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    derivedCreatedByRunId: uuid("derived_created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    derivedAuthorSource: text("derived_author_source").$type<IssueCommentDerivedAuthorSource>(),
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
