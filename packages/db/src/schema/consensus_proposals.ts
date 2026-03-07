import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Consensus proposals — the decision-making backbone.
 *
 * Agents can propose decisions, strategies, or knowledge ratifications
 * that require agreement from other agents or the board. Each proposal
 * goes through a lifecycle: draft → open → passed/rejected/vetoed.
 */
export const consensusProposals = pgTable(
  "consensus_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Proposal title */
    title: text("title").notNull(),
    /** Full description of what is being proposed */
    description: text("description").notNull(),
    /** Proposal type: "strategy", "knowledge", "policy", "action", "resource" */
    proposalType: text("proposal_type").notNull().default("action"),
    /** Current status: "draft", "open", "passed", "rejected", "vetoed", "expired" */
    status: text("status").notNull().default("draft"),
    /** Agent that created the proposal */
    proposerAgentId: uuid("proposer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** User that created the proposal (null = agent) */
    proposerUserId: text("proposer_user_id"),
    /** Quorum type: "majority", "supermajority", "unanimous", "board_approval" */
    quorumType: text("quorum_type").notNull().default("majority"),
    /** Minimum number of votes required for quorum (0 = auto-calculate from org) */
    quorumMinVotes: integer("quorum_min_votes").notNull().default(0),
    /** Structured payload (the proposed change data) */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** ID of the knowledge entry this proposal would ratify (if any) */
    knowledgeEntryId: uuid("knowledge_entry_id"),
    /** Vote counts */
    votesFor: integer("votes_for").notNull().default(0),
    votesAgainst: integer("votes_against").notNull().default(0),
    votesAbstain: integer("votes_abstain").notNull().default(0),
    /** Deadline for voting */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When the proposal was resolved */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Agent or user that vetoed (if vetoed) */
    vetoedBy: text("vetoed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("consensus_proposals_company_idx").on(table.companyId),
    companyStatusIdx: index("consensus_proposals_company_status_idx").on(table.companyId, table.status),
    proposerIdx: index("consensus_proposals_proposer_idx").on(table.proposerAgentId),
    expiresIdx: index("consensus_proposals_expires_idx").on(table.expiresAt),
  }),
);

/**
 * Votes on consensus proposals.
 */
export const consensusVotes = pgTable(
  "consensus_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => consensusProposals.id, { onDelete: "cascade" }),
    /** Voting agent (null = board vote) */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** Voting user (null = agent vote) */
    userId: text("user_id"),
    /** Vote value: "for", "against", "abstain" */
    vote: text("vote").notNull(),
    /** Optional reasoning/justification */
    reasoning: text("reasoning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalIdx: index("consensus_votes_proposal_idx").on(table.proposalId),
    agentIdx: index("consensus_votes_agent_idx").on(table.agentId),
  }),
);
