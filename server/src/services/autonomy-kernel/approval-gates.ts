import { and, eq, sql } from "drizzle-orm";
import { approvals } from "@paperclipai/db";
import type { ApprovalGateSummary } from "@paperclipai/shared";
import type { AutonomyKernelContext, PreflightRunRequest } from "./types.js";

export interface ApprovalGateRequest extends PreflightRunRequest {
  governedAction: string;
  risk?: string | null;
  policySource?: string | null;
}

type ApprovalRow = typeof approvals.$inferSelect;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function approvalGateSummaryFromApproval(row: ApprovalRow): ApprovalGateSummary {
  const payload = row.payload as Record<string, unknown>;
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status as ApprovalGateSummary["status"],
    approvalId: row.id,
    laneKey: typeof payload.laneKey === "string" ? payload.laneKey : null,
    runId: typeof payload.runId === "string" ? payload.runId : null,
    issueId: typeof payload.issueId === "string" ? payload.issueId : null,
    agentId: row.requestedByAgentId ?? (typeof payload.agentId === "string" ? payload.agentId : null),
    governedAction: typeof payload.governedAction === "string" ? payload.governedAction : "autonomy_run",
    risk: typeof payload.risk === "string" ? payload.risk : null,
    policySource: typeof payload.policySource === "string" ? payload.policySource : null,
    requestedByAgentId: row.requestedByAgentId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    acceptActionLabel: typeof payload.acceptActionLabel === "string" ? payload.acceptActionLabel : "Approve run",
    rejectActionLabel: typeof payload.rejectActionLabel === "string" ? payload.rejectActionLabel : "Reject run",
    expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
    decidedByUserId: row.decidedByUserId ?? null,
    decidedAt: toIso(row.decidedAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function createApprovalGateService(context: AutonomyKernelContext) {
  const { db } = context;

  return {
    async ensureVisibleApprovalGate(request: ApprovalGateRequest): Promise<ApprovalGateSummary> {
      const payload = {
        kind: "autonomy_preflight_gate",
        laneKey: request.laneKey ?? null,
        runId: request.runId,
        issueId: request.issueId ?? null,
        agentId: request.agentId ?? null,
        governedAction: request.governedAction,
        risk: request.risk ?? null,
        policySource: request.policySource ?? null,
        acceptActionLabel: "Approve autonomous run",
        rejectActionLabel: "Deny autonomous run",
      };

      const [existing] = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, request.companyId),
            eq(approvals.type, "autonomy_preflight_gate"),
            eq(approvals.status, "pending"),
            sql`${approvals.payload}->>'runId' = ${request.runId}`,
            sql`${approvals.payload}->>'governedAction' = ${request.governedAction}`,
          ),
        )
        .limit(1);
      if (existing) return approvalGateSummaryFromApproval(existing);

      const now = new Date();
      const [created] = await db
        .insert(approvals)
        .values({
          companyId: request.companyId,
          type: "autonomy_preflight_gate",
          requestedByAgentId: request.agentId ?? null,
          requestedByUserId: request.requestedByActorType === "user" ? (request.requestedByActorId ?? null) : null,
          status: "pending",
          payload,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return approvalGateSummaryFromApproval(created);
    },
  };
}
