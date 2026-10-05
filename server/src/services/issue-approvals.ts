import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { acquireIssueLifecycleFenceInTransaction } from "./issue-lifecycle-fence.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LinkWriter = Pick<Db, "select" | "insert">;

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

async function persistApprovalLink(
  writer: LinkWriter, issueId: string, approvalId: string, actor?: LinkActor, companyId?: string,
) {
  const issue = await writer.select().from(issues)
    .where(and(eq(issues.id, issueId), companyId === undefined ? undefined : eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const approval = await writer.select().from(approvals)
    .where(and(eq(approvals.id, approvalId), companyId === undefined ? undefined : eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!approval) throw notFound("Approval not found");
  if (issue.companyId !== approval.companyId || (companyId !== undefined && issue.companyId !== companyId)) {
    throw unprocessable("Issue and approval must belong to the same company");
  }
  await writer.insert(issueApprovals).values({
    companyId: issue.companyId, issueId, approvalId,
    linkedByAgentId: actor?.agentId ?? null, linkedByUserId: actor?.userId ?? null,
  }).onConflictDoNothing();
  return writer.select().from(issueApprovals)
    .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId),
      companyId === undefined ? undefined : eq(issueApprovals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
}

// Dark supplied-tx participant; no production caller opts in. Caller must acquire
// this company protocol before earlier domain reads/locks too. Not authorization.
export async function linkIssueApprovalInTransaction(tx: Transaction, input: {
  companyId: string; issueId: string; approvalId: string; actor?: LinkActor;
}) {
  const companyId = input.companyId;
  const issueId = input.issueId;
  const approvalId = input.approvalId;
  const actor = { agentId: input.actor?.agentId ?? null, userId: input.actor?.userId ?? null };
  if (!companyId) throw unprocessable("Lifecycle-fenced approval link requires companyId");
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalLink(tx, issueId, approvalId, actor, companyId);
}

async function persistApprovalUnlink(
  writer: Pick<Db, "select" | "delete">, issueId: string, approvalId: string, companyId?: string,
) {
  const issue = await writer.select().from(issues)
    .where(and(eq(issues.id, issueId), companyId === undefined ? undefined : eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const approval = await writer.select().from(approvals)
    .where(and(eq(approvals.id, approvalId), companyId === undefined ? undefined : eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!approval) throw notFound("Approval not found");
  if (issue.companyId !== approval.companyId || (companyId !== undefined && issue.companyId !== companyId)) {
    throw unprocessable("Issue and approval must belong to the same company");
  }
  await writer.delete(issueApprovals).where(and(
    eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId),
    companyId === undefined ? undefined : eq(issueApprovals.companyId, companyId),
  ));
}

// Dark supplied-tx participant, not authorization or a production opt-in.
export async function unlinkIssueApprovalInTransaction(tx: Transaction, input: {
  companyId: string; issueId: string; approvalId: string;
}) {
  const companyId = input.companyId;
  const issueId = input.issueId;
  const approvalId = input.approvalId;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval unlink requires companyId");
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalUnlink(tx, issueId, approvalId, companyId);
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

    link: async (issueId: string, approvalId: string, actor?: LinkActor,
      options?: { lifecycleFence?: boolean; companyId?: string }) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval link requires companyId");
        const capturedActor = { agentId: actor?.agentId ?? null, userId: actor?.userId ?? null };
        return db.transaction((tx) => linkIssueApprovalInTransaction(tx, {
          companyId, issueId, approvalId, actor: capturedActor,
        }));
      }
      return persistApprovalLink(db, issueId, approvalId, actor);
    },

    unlink: async (issueId: string, approvalId: string,
      options?: { lifecycleFence?: boolean; companyId?: string }) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval unlink requires companyId");
        return db.transaction((tx) => unlinkIssueApprovalInTransaction(tx, { companyId, issueId, approvalId }));
      }
      return persistApprovalUnlink(db, issueId, approvalId);
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

      await db
        .insert(issueApprovals)
        .values(
          uniqueIssueIds.map((issueId) => ({
            companyId: approval.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })),
        )
        .onConflictDoNothing();
    },
  };
}
