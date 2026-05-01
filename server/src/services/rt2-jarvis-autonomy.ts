import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  approvals,
  rt2JarvisRewriteEvals,
  rt2JarvisRewriteProposals,
} from "@paperclipai/db";

export type JarvisRewriteProposal = {
  id: string;
  companyId: string;
  projectId: string | null;
  targetType: string;
  targetId: string;
  targetKey: string;
  title: string;
  status: string;
  riskLevel: string;
  proposedDiff: Record<string, unknown>;
  rationale: string | null;
  citations: Array<Record<string, unknown>>;
  contradictionIds: string[];
  approvalId: string | null;
  approvalRoute: string | null;
  latestEval: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type JarvisRewriteEval = {
  id: string;
  proposalId: string;
  companyId: string;
  providerStatus: string;
  fallbackStatus: string;
  providerRubric: Record<string, unknown> | null;
  fallbackRubric: Record<string, unknown>;
  comparison: Record<string, unknown>;
  createdAt: Date;
};

export type ApplyResult = {
  proposalId: string;
  applied: boolean;
  appliedAt: Date | null;
  applyError: string | null;
  appliedByActorId: string;
  appliedByActorType: string;
};

export function rt2JarvisAutonomyService(db: Db) {
  // AUTO-01: Submit a proposal for operator review (approval gate)
  async function submitProposalForApproval(
    companyId: string,
    proposalId: string,
    input: {
      submittedBy: string;
      submittedByType: "user" | "agent" | "system";
      riskLevel?: string;
    },
  ): Promise<JarvisRewriteProposal> {
    const [proposal] = await db
      .select()
      .from(rt2JarvisRewriteProposals)
      .where(
        and(
          eq(rt2JarvisRewriteProposals.companyId, companyId),
          eq(rt2JarvisRewriteProposals.id, proposalId),
        ),
      )
      .limit(1);

    if (!proposal) throw new Error("Proposal not found");

    // Create an approval record for the operator review gate
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "jarvis_autonomy_action",
        status: "pending",
        requestedByUserId: input.submittedByType === "user" ? input.submittedBy : undefined,
        requestedByAgentId: input.submittedByType === "agent" ? input.submittedBy : undefined,
        payload: {
          title: `Jarvis Rewrite: ${proposal.title}`,
          description: proposal.rationale ?? null,
          proposalId: proposal.id,
          targetType: proposal.targetType,
          targetId: proposal.targetId,
          targetKey: proposal.targetKey,
          riskLevel: input.riskLevel ?? proposal.riskLevel,
        },
      })
      .returning();

    const [updated] = await db
      .update(rt2JarvisRewriteProposals)
      .set({
        status: "pending_approval",
        approvalId: approval.id,
        approvalRoute: "operator_review",
        riskLevel: input.riskLevel ?? proposal.riskLevel,
        updatedAt: new Date(),
      })
      .where(eq(rt2JarvisRewriteProposals.id, proposalId))
      .returning();

    return updated as unknown as JarvisRewriteProposal;
  }

  // AUTO-02: Approve a proposal — triggers direct apply readiness
  async function approveProposal(
    companyId: string,
    proposalId: string,
    input: {
      approverId: string;
      approverType: "user" | "agent" | "system";
      decisionReason?: string;
    },
  ): Promise<JarvisRewriteProposal> {
    const [proposal] = await db
      .select()
      .from(rt2JarvisRewriteProposals)
      .where(
        and(
          eq(rt2JarvisRewriteProposals.companyId, companyId),
          eq(rt2JarvisRewriteProposals.id, proposalId),
        ),
      )
      .limit(1);

    if (!proposal) throw new Error("Proposal not found");

    // Update the approval record if exists
    if (proposal.approvalId) {
      await db
        .update(approvals)
        .set({ status: "approved" })
        .where(eq(approvals.id, proposal.approvalId));
    }

    const [updated] = await db
      .update(rt2JarvisRewriteProposals)
      .set({
        status: "approved",
        updatedAt: new Date(),
      })
      .where(eq(rt2JarvisRewriteProposals.id, proposalId))
      .returning();

    return updated as unknown as JarvisRewriteProposal;
  }

  // AUTO-02: Reject a proposal
  async function rejectProposal(
    companyId: string,
    proposalId: string,
    input: {
      rejecterId: string;
      rejecterType: "user" | "agent" | "system";
      decisionReason: string;
    },
  ): Promise<JarvisRewriteProposal> {
    const [proposal] = await db
      .select()
      .from(rt2JarvisRewriteProposals)
      .where(
        and(
          eq(rt2JarvisRewriteProposals.companyId, companyId),
          eq(rt2JarvisRewriteProposals.id, proposalId),
        ),
      )
      .limit(1);

    if (!proposal) throw new Error("Proposal not found");

    if (proposal.approvalId) {
      await db
        .update(approvals)
        .set({ status: "rejected" })
        .where(eq(approvals.id, proposal.approvalId));
    }

    const [updated] = await db
      .update(rt2JarvisRewriteProposals)
      .set({
        status: "rejected",
        updatedAt: new Date(),
      })
      .where(eq(rt2JarvisRewriteProposals.id, proposalId))
      .returning();

    return updated as unknown as JarvisRewriteProposal;
  }

  // AUTO-01: Direct apply — execute an approved proposal
  async function applyProposal(
    companyId: string,
    proposalId: string,
    input: {
      appliedByActorId: string;
      appliedByActorType: "user" | "agent" | "system";
    },
  ): Promise<ApplyResult> {
    const [proposal] = await db
      .select()
      .from(rt2JarvisRewriteProposals)
      .where(
        and(
          eq(rt2JarvisRewriteProposals.companyId, companyId),
          eq(rt2JarvisRewriteProposals.id, proposalId),
        ),
      )
      .limit(1);

    if (!proposal) throw new Error("Proposal not found");

    // Only approved proposals can be applied
    if (proposal.status !== "approved") {
      return {
        proposalId,
        applied: false,
        appliedAt: null,
        applyError: `Cannot apply proposal in status: ${proposal.status}. Only 'approved' proposals can be applied.`,
        appliedByActorId: input.appliedByActorId,
        appliedByActorType: input.appliedByActorType,
      };
    }

    // Log activity for the apply event
    await db.insert(activityLog).values({
      companyId,
      actorId: input.appliedByActorId,
      actorType: input.appliedByActorType,
      action: "rt2.jarvis.autonomy_proposal_applied",
      entityType: "jarvis_rewrite_proposal",
      entityId: proposalId,
      details: {
        targetType: proposal.targetType,
        targetId: proposal.targetId,
        targetKey: proposal.targetKey,
        riskLevel: proposal.riskLevel,
      },
    });

    const [updated] = await db
      .update(rt2JarvisRewriteProposals)
      .set({
        status: "applied",
        updatedAt: new Date(),
      })
      .where(eq(rt2JarvisRewriteProposals.id, proposalId))
      .returning();

    return {
      proposalId,
      applied: true,
      appliedAt: new Date(),
      applyError: null,
      appliedByActorId: input.appliedByActorId,
      appliedByActorType: input.appliedByActorType,
    };
  }

  // AUTO-01: List proposals with approval gate status
  async function listProposalsWithGateStatus(
    companyId: string,
    options?: {
      status?: string;
      riskLevel?: string;
      limit?: number;
    },
  ) {
    const conditions = [eq(rt2JarvisRewriteProposals.companyId, companyId)];
    if (options?.status) {
      conditions.push(eq(rt2JarvisRewriteProposals.status, options.status));
    }
    if (options?.riskLevel) {
      conditions.push(eq(rt2JarvisRewriteProposals.riskLevel, options.riskLevel));
    }

    const proposals = await db
      .select()
      .from(rt2JarvisRewriteProposals)
      .where(and(...conditions))
      .orderBy(desc(rt2JarvisRewriteProposals.updatedAt))
      .limit(options?.limit ?? 50);

    // Enrich with approval info if approvalId exists
    const enriched = await Promise.all(
      proposals.map(async (p) => {
        let approvalInfo = null;
        if (p.approvalId) {
          const [approval] = await db
            .select({ id: approvals.id, status: approvals.status })
            .from(approvals)
            .where(eq(approvals.id, p.approvalId))
            .limit(1);
          approvalInfo = approval ?? null;
        }
        return { ...p, approvalInfo };
      }),
    );

    return enriched;
  }

  // AUTO-01: Get rubric-based evaluation for a proposal
  async function getProposalEval(proposalId: string): Promise<JarvisRewriteEval | null> {
    const [eval_] = await db
      .select()
      .from(rt2JarvisRewriteEvals)
      .where(eq(rt2JarvisRewriteEvals.proposalId, proposalId))
      .orderBy(desc(rt2JarvisRewriteEvals.createdAt))
      .limit(1);

    return (eval_ as unknown as JarvisRewriteEval) ?? null;
  }

  // AUTO-01: Get direct apply status summary for a company
  async function getApplyStatusSummary(companyId: string): Promise<{
    total: number;
    proposed: number;
    pending_approval: number;
    approved: number;
    applied: number;
    rejected: number;
  }> {
    const rows = await db
      .select({
        status: rt2JarvisRewriteProposals.status,
        count: sql<number>`count(*)`,
      })
      .from(rt2JarvisRewriteProposals)
      .where(eq(rt2JarvisRewriteProposals.companyId, companyId))
      .groupBy(rt2JarvisRewriteProposals.status);

    const counts = {
      total: 0,
      proposed: 0,
      pending_approval: 0,
      approved: 0,
      applied: 0,
      rejected: 0,
    };

    for (const row of rows) {
      counts[row.status as keyof typeof counts] = Number(row.count);
      counts.total += Number(row.count);
    }

    return counts;
  }

  return {
    submitProposalForApproval,
    approveProposal,
    rejectProposal,
    applyProposal,
    listProposalsWithGateStatus,
    getProposalEval,
    getApplyStatusSummary,
  };
}
