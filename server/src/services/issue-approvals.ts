import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { lockCompanyIssueGraph } from "./issues.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string) {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueAndApprovalSameCompany(issueId: string, approvalId: string) {
    const issue = await getIssue(issueId);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");

    if (issue.companyId !== approval.companyId) {
      throw unprocessable("Issue and approval must belong to the same company");
    }

    return { issue, approval };
  }

  return {
    listApprovalsForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const result = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
        .orderBy(desc(issueApprovals.createdAt));
      return result.map((approval) => ({
        ...approval,
        payload: redactEventPayload(approval.payload) ?? {},
      }));
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      const initial = await assertIssueAndApprovalSameCompany(issueId, approvalId);
      return db.transaction(async (tx) => {
        await lockCompanyIssueGraph(initial.issue.companyId, tx);
        const issue = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const approval = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");
        if (!approval) throw notFound("Approval not found");
        if (issue.companyId !== approval.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
        if (
          (approval.status === "pending" || approval.status === "revision_requested")
          && (issue.status === "done" || issue.status === "cancelled")
        ) {
          throw conflict("Cannot link a pending approval to a closed issue");
        }

        await tx
          .insert(issueApprovals)
          .values({
            companyId: issue.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })
          .onConflictDoNothing();

        return tx
          .select()
          .from(issueApprovals)
          .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
          .then((rows) => rows[0] ?? null);
      });
    },

    unlink: async (issueId: string, approvalId: string) => {
      const { issue } = await assertIssueAndApprovalSameCompany(issueId, approvalId);
      await db.transaction(async (tx) => {
        await lockCompanyIssueGraph(issue.companyId, tx);
        await tx
          .delete(issueApprovals)
          .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)));
      });
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return;

      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const uniqueIssueIds = Array.from(new Set(issueIds));
      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(inArray(issues.id, uniqueIssueIds));

      if (rows.length !== uniqueIssueIds.length) {
        throw notFound("One or more issues not found");
      }

      for (const row of rows) {
        if (row.companyId !== approval.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
      }

      await db.transaction(async (tx) => {
        await lockCompanyIssueGraph(approval.companyId, tx);
        const lockedApproval = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .for("update")
          .then((approvalRows) => approvalRows[0] ?? null);
        if (!lockedApproval) throw notFound("Approval not found");
        const lockedIssues = await tx
          .select()
          .from(issues)
          .where(inArray(issues.id, uniqueIssueIds))
          .orderBy(issues.id)
          .for("update");
        if (lockedIssues.length !== uniqueIssueIds.length) {
          throw notFound("One or more issues not found");
        }
        if (lockedIssues.some((issue) => issue.companyId !== lockedApproval.companyId)) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
        if (
          (lockedApproval.status === "pending" || lockedApproval.status === "revision_requested")
          && lockedIssues.some((issue) => issue.status === "done" || issue.status === "cancelled")
        ) {
          throw conflict("Cannot link a pending approval to a closed issue");
        }
        await tx
          .insert(issueApprovals)
          .values(
            uniqueIssueIds.map((issueId) => ({
              companyId: lockedApproval.companyId,
              issueId,
              approvalId,
              linkedByAgentId: actor?.agentId ?? null,
              linkedByUserId: actor?.userId ?? null,
            })),
          )
          .onConflictDoNothing();
      });
    },
  };
}
