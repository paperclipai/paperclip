import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Company knowledge base — shared facts, decisions, and documents
 * accessible to all agents within the company.
 *
 * Knowledge entries are the "source of truth" layer — agents can
 * contribute knowledge and query it, but entries require either
 * board approval or consensus to become "ratified".
 */
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Category/namespace for organizing knowledge, e.g. "architecture", "policy", "decision" */
    category: text("category").notNull().default("general"),
    /** Short title/summary */
    title: text("title").notNull(),
    /** Full content of the knowledge entry */
    content: text("content").notNull(),
    /** Structured metadata (tags, source references, etc.) */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    /** Status: draft → proposed → ratified → archived */
    status: text("status").notNull().default("draft"),
    /** If stored in Vault, the Vault path reference */
    vaultRef: text("vault_ref"),
    /** Agent that authored this entry (null = board) */
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** User that authored this entry (null = agent) */
    authorUserId: text("author_user_id"),
    /** Version number (incremented on edits) */
    version: text("version").notNull().default("1"),
    /** ID of the consensus proposal that ratified this (if any) */
    ratifiedByProposalId: uuid("ratified_by_proposal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("knowledge_entries_company_idx").on(table.companyId),
    companyCategoryIdx: index("knowledge_entries_company_category_idx").on(table.companyId, table.category),
    companyStatusIdx: index("knowledge_entries_company_status_idx").on(table.companyId, table.status),
    authorAgentIdx: index("knowledge_entries_author_agent_idx").on(table.authorAgentId),
  }),
);
