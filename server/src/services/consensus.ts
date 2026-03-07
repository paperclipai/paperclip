/**
 * Consensus service — proposal and voting mechanism.
 *
 * Agents can propose decisions, and the org votes to reach consensus.
 * Proposals follow: draft → open → passed/rejected/vetoed/expired.
 * The board can veto any proposal.
 */

import { and, eq, desc, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { consensusProposals, consensusVotes, knowledgeEntries, agents } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

export function consensusService(db: Db) {
  async function getProposalById(id: string) {
    return db
      .select()
      .from(consensusProposals)
      .where(eq(consensusProposals.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function countCompanyAgents(companyId: string): Promise<number> {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    return rows.length;
  }

  function checkQuorum(
    proposal: { quorumType: string; quorumMinVotes: number; votesFor: number; votesAgainst: number; votesAbstain: number },
    totalAgents: number,
  ): { reached: boolean; passed: boolean } {
    const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
    const minVotes = proposal.quorumMinVotes > 0 ? proposal.quorumMinVotes : Math.max(1, Math.ceil(totalAgents / 2));

    if (totalVotes < minVotes) return { reached: false, passed: false };

    switch (proposal.quorumType) {
      case "majority":
        return { reached: true, passed: proposal.votesFor > proposal.votesAgainst };
      case "supermajority": {
        const threshold = Math.ceil(totalVotes * 2 / 3);
        return { reached: true, passed: proposal.votesFor >= threshold };
      }
      case "unanimous":
        return { reached: true, passed: proposal.votesAgainst === 0 && proposal.votesFor > 0 };
      case "board_approval":
        // Board approval is handled separately via veto/approve
        return { reached: true, passed: proposal.votesFor > proposal.votesAgainst };
      default:
        return { reached: true, passed: proposal.votesFor > proposal.votesAgainst };
    }
  }

  return {
    /** List proposals for a company */
    list: (companyId: string, filters?: { status?: string }) => {
      const conditions = [eq(consensusProposals.companyId, companyId)];
      if (filters?.status) {
        conditions.push(eq(consensusProposals.status, filters.status));
      }
      return db
        .select()
        .from(consensusProposals)
        .where(and(...conditions))
        .orderBy(desc(consensusProposals.createdAt));
    },

    /** Get a proposal by ID */
    getById: getProposalById,

    /** Create a new proposal */
    create: async (
      companyId: string,
      input: {
        title: string;
        description: string;
        proposalType?: string;
        quorumType?: string;
        quorumMinVotes?: number;
        payload?: Record<string, unknown>;
        knowledgeEntryId?: string | null;
        expiresAt?: string | null;
      },
      actor?: { agentId?: string | null; userId?: string | null },
    ) =>
      db
        .insert(consensusProposals)
        .values({
          companyId,
          title: input.title,
          description: input.description,
          proposalType: input.proposalType ?? "action",
          status: "open",
          proposerAgentId: actor?.agentId ?? null,
          proposerUserId: actor?.userId ?? null,
          quorumType: input.quorumType ?? "majority",
          quorumMinVotes: input.quorumMinVotes ?? 0,
          payload: input.payload ?? null,
          knowledgeEntryId: input.knowledgeEntryId ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning()
        .then((rows) => rows[0]),

    /** Cast a vote on a proposal */
    vote: async (
      proposalId: string,
      input: { vote: string; reasoning?: string | null },
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const proposal = await getProposalById(proposalId);
      if (!proposal) throw notFound("Proposal not found");
      if (proposal.status !== "open") {
        throw unprocessable(`Cannot vote on a ${proposal.status} proposal`);
      }

      // Check for duplicate votes
      const existingVotes = await db
        .select()
        .from(consensusVotes)
        .where(
          and(
            eq(consensusVotes.proposalId, proposalId),
            actor.agentId
              ? eq(consensusVotes.agentId, actor.agentId)
              : eq(consensusVotes.userId, actor.userId ?? ""),
          ),
        );
      if (existingVotes.length > 0) {
        throw conflict("Already voted on this proposal");
      }

      // Record the vote
      const vote = await db
        .insert(consensusVotes)
        .values({
          proposalId,
          agentId: actor.agentId ?? null,
          userId: actor.userId ?? null,
          vote: input.vote,
          reasoning: input.reasoning ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      // Update vote counts
      const increment =
        input.vote === "for"
          ? { votesFor: proposal.votesFor + 1 }
          : input.vote === "against"
            ? { votesAgainst: proposal.votesAgainst + 1 }
            : { votesAbstain: proposal.votesAbstain + 1 };

      const updated = await db
        .update(consensusProposals)
        .set({ ...increment, updatedAt: new Date() })
        .where(eq(consensusProposals.id, proposalId))
        .returning()
        .then((rows) => rows[0]!);

      // Check if quorum is reached and auto-resolve
      const totalAgents = await countCompanyAgents(proposal.companyId);
      const quorum = checkQuorum(updated, totalAgents);

      if (quorum.reached) {
        const newStatus = quorum.passed ? "passed" : "rejected";
        await db
          .update(consensusProposals)
          .set({ status: newStatus, resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(consensusProposals.id, proposalId));

        // If passed and linked to a knowledge entry, ratify it
        if (quorum.passed && updated.knowledgeEntryId) {
          await db
            .update(knowledgeEntries)
            .set({
              status: "ratified",
              ratifiedByProposalId: proposalId,
              updatedAt: new Date(),
            })
            .where(eq(knowledgeEntries.id, updated.knowledgeEntryId));
        }
      }

      return vote;
    },

    /** Board veto — immediately rejects a proposal */
    veto: async (proposalId: string, vetoedBy: string) => {
      const proposal = await getProposalById(proposalId);
      if (!proposal) throw notFound("Proposal not found");
      if (proposal.status !== "open") {
        throw unprocessable(`Cannot veto a ${proposal.status} proposal`);
      }
      return db
        .update(consensusProposals)
        .set({
          status: "vetoed",
          vetoedBy,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(consensusProposals.id, proposalId))
        .returning()
        .then((rows) => rows[0]);
    },

    /** List votes for a proposal */
    listVotes: (proposalId: string) =>
      db
        .select()
        .from(consensusVotes)
        .where(eq(consensusVotes.proposalId, proposalId))
        .orderBy(consensusVotes.createdAt),

    /** Expire proposals past their deadline */
    expireOverdue: () =>
      db
        .update(consensusProposals)
        .set({ status: "expired", resolvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(consensusProposals.status, "open"),
            lt(consensusProposals.expiresAt, new Date()),
          ),
        ),
  };
}
