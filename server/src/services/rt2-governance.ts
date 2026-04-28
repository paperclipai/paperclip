import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, approvalComments } from "@paperclipai/db";
import type {
  CreateApprovalRequest,
  Rt2Approval,
  Rt2ApprovalWithComments,
  Rt2ActivityLogEntry,
  Rt2GovernanceStatus,
  Rt2ApprovalType,
  Rt2ApprovalStatus,
  ActivityLogFilter,
  ApprovalQueueFilter,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

/**
 * Full Governance Service
 *
 * Provides:
 * - getGovernanceStatus: Query pending/approved/rejected counts + avg time
 * - getApprovalQueue: Query approvals with optional type/status filter
 * - getApprovalById: Single approval with comments
 * - createApproval: Insert new approval
 * - approve: Update status to 'approved'
 * - reject: Update status to 'rejected'
 * - addComment: Add comment
 * - getActivityLog: Query activity_log with filters
 */

export function rt2GovernanceService(db: Db) {
  /**
   * Get governance status overview for a company
   */
  const getGovernanceStatus = async (companyId: string): Promise<Rt2GovernanceStatus> => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get pending count
    const pendingResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(eq(approvals.companyId, companyId))
      .then((rows) => Number(rows[0]?.count ?? 0));

    // Get approved this week
    const approvedResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "approved" as string),
          gte(approvals.decidedAt, weekAgo),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));

    // Get rejected this week
    const rejectedResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "rejected" as string),
          gte(approvals.decidedAt, weekAgo),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));

    // Calculate average approval time (in hours) for approvals decided this week
    const decidedApprovals = await db
      .select({
        decidedAt: approvals.decidedAt,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "approved" as string),
          gte(approvals.decidedAt, weekAgo),
        ),
      );

    let averageApprovalTimeHours = 0;
    if (decidedApprovals.length > 0) {
      const totalHours = decidedApprovals.reduce((sum, row) => {
        if (row.decidedAt && row.createdAt) {
          const diffMs = row.decidedAt.getTime() - row.createdAt.getTime();
          return sum + diffMs / (1000 * 60 * 60);
        }
        return sum;
      }, 0);
      averageApprovalTimeHours = Math.round((totalHours / decidedApprovals.length) * 10) / 10;
    }

    return {
      companyId,
      pendingApprovals: pendingResult,
      approvedThisWeek: approvedResult,
      rejectedThisWeek: rejectedResult,
      averageApprovalTimeHours,
    };
  };

  /**
   * Get approval queue with optional filters
   */
  const getApprovalQueue = async (
    companyId: string,
    filter?: ApprovalQueueFilter,
  ): Promise<Rt2Approval[]> => {
    const conditions = [eq(approvals.companyId, companyId)];

    if (filter?.type) {
      conditions.push(eq(approvals.type, filter.type as Rt2ApprovalType));
    }
    if (filter?.status) {
      conditions.push(eq(approvals.status, filter.status as string));
    }

    const rows = await db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt));

    return rows.map(mapApprovalRow);
  };

  /**
   * Get single approval with comments
   */
  const getApprovalById = async (
    companyId: string,
    approvalId: string,
  ): Promise<Rt2ApprovalWithComments | null> => {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));

    if (rows.length === 0) {
      return null;
    }

    const approval = mapApprovalRow(rows[0]);

    // Get comments
    const commentRows = await db
      .select()
      .from(approvalComments)
      .where(eq(approvalComments.approvalId, approvalId))
      .orderBy(asc(approvalComments.createdAt));

    const comments = commentRows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      approvalId: row.approvalId,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      body: row.body,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return {
      ...approval,
      comments,
    };
  };

  /**
   * Create a new approval request
   */
  const createApproval = async (
    companyId: string,
    request: CreateApprovalRequest,
  ): Promise<Rt2Approval> => {
    const now = new Date();

    const insertResult = await db
      .insert(approvals)
      .values({
        companyId,
        type: request.type,
        requestedByAgentId: request.requestedByAgentId ?? null,
        requestedByUserId: request.requestedByUserId ?? null,
        status: "pending",
        payload: request.payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return mapApprovalRow(insertResult[0]);
  };

  /**
   * Approve an approval request
   */
  const approve = async (
    companyId: string,
    approvalId: string,
    userId: string,
    decisionNote?: string,
  ): Promise<Rt2Approval> => {
    const now = new Date();

    const updateResult = await db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: userId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
      .returning();

    if (updateResult.length === 0) {
      throw notFound(`Approval ${approvalId} not found`);
    }

    return mapApprovalRow(updateResult[0]);
  };

  /**
   * Reject an approval request
   */
  const reject = async (
    companyId: string,
    approvalId: string,
    userId: string,
    decisionNote?: string,
  ): Promise<Rt2Approval> => {
    const now = new Date();

    const updateResult = await db
      .update(approvals)
      .set({
        status: "rejected",
        decidedByUserId: userId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
      .returning();

    if (updateResult.length === 0) {
      throw notFound(`Approval ${approvalId} not found`);
    }

    return mapApprovalRow(updateResult[0]);
  };

  /**
   * Add a comment to an approval
   */
  const addComment = async (
    companyId: string,
    approvalId: string,
    authorId: { agentId?: string; userId?: string },
    body: string,
  ): Promise<import("@paperclipai/shared").Rt2ApprovalComment> => {
    const now = new Date();

    const insertResult = await db
      .insert(approvalComments)
      .values({
        companyId,
        approvalId,
        authorAgentId: authorId.agentId ?? null,
        authorUserId: authorId.userId ?? null,
        body,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = insertResult[0];
    return {
      id: row.id,
      companyId: row.companyId,
      approvalId: row.approvalId,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      body: row.body,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  /**
   * Get activity log with filters
   * Tool-call entries use entityType='tool_call', action=tool_name
   */
  const getActivityLog = async (
    companyId: string,
    filters?: ActivityLogFilter,
  ): Promise<Rt2ActivityLogEntry[]> => {
    const conditions = [eq(activityLog.companyId, companyId)];

    if (filters?.entityType) {
      conditions.push(eq(activityLog.entityType, filters.entityType));
    }
    if (filters?.action) {
      conditions.push(eq(activityLog.action, filters.action));
    }
    if (filters?.actorType) {
      conditions.push(eq(activityLog.actorType, filters.actorType));
    }
    if (filters?.fromDate) {
      conditions.push(gte(activityLog.createdAt, filters.fromDate));
    }
    if (filters?.toDate) {
      conditions.push(lte(activityLog.createdAt, filters.toDate));
    }

    const limit = filters?.limit ?? 100;

    const rows = await db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      actorType: row.actorType as import("@paperclipai/shared").ActorType,
      actorId: row.actorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      agentId: row.agentId,
      runId: row.runId,
      details: row.details ?? null,
      createdAt: row.createdAt,
    }));
  };

  return {
    getGovernanceStatus,
    getApprovalQueue,
    getApprovalById,
    createApproval,
    approve,
    reject,
    addComment,
    getActivityLog,
  };
}

function mapApprovalRow(row: typeof approvals.$inferSelect): Rt2Approval {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as Rt2ApprovalType,
    requestedByAgentId: row.requestedByAgentId,
    requestedByUserId: row.requestedByUserId,
    status: row.status as Rt2ApprovalStatus,
    payload: row.payload,
    decisionNote: row.decisionNote,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
