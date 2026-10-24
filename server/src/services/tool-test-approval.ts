import { and, eq } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import type { ToolRedactedValueSummary } from "@paperclipai/shared";
import { writeToolReviewChange } from "./tool-review-work-notifications.js";

export type ToolTestApprovalClaim = { actionRequestId: string; invocationId: string; claimedAt: Date };
export type ToolTestOutcome = {
  status: "succeeded" | "failed" | "timed_out" | "rate_limited";
  result?: ToolRedactedValueSummary;
  errorCode?: string;
  errorMessage?: string;
};

export async function claimToolTestApproval(db: Db, actionRequestId: string, invocationId: string): Promise<ToolTestApprovalClaim | null> {
  return writeToolReviewChange(db, async tx => {
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, actionRequestId), eq(toolActionRequests.invocationId, invocationId))).for("update");
    if (!invocation || request?.status !== "approved") return null;
    const now = new Date();
    if (invocation.status !== "awaiting_approval") {
      if (["succeeded", "failed", "denied", "timed_out", "rate_limited"].includes(invocation.status)) {
        await tx.update(toolActionRequests).set({ status: invocation.status === "succeeded" ? "executed" : "failed",
          resolvedAt: invocation.completedAt ?? now, updatedAt: now }).where(eq(toolActionRequests.id, actionRequestId));
      } else if (invocation.status === "executing") {
        await tx.update(toolActionRequests).set({ status: "executing", updatedAt: invocation.startedAt ?? invocation.updatedAt })
          .where(eq(toolActionRequests.id, actionRequestId));
      }
      return null;
    }
    await tx.update(toolActionRequests).set({ status: "executing", updatedAt: now })
      .where(eq(toolActionRequests.id, actionRequestId));
    return { actionRequestId, invocationId, claimedAt: now };
  });
}

export async function startToolTestInvocation(db: Db, invocationId: string, claim?: ToolTestApprovalClaim) {
  const now = new Date();
  if (!claim) {
    await db.update(toolInvocations).set({ status: "executing", startedAt: now, updatedAt: now })
      .where(eq(toolInvocations.id, invocationId));
    return true;
  }
  return db.transaction(async tx => {
    const [invocation] = await tx.select({ status: toolInvocations.status }).from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(eq(toolActionRequests.id, claim.actionRequestId)).for("update");
    if (invocation?.status !== "awaiting_approval" || request?.status !== "executing" ||
      request.updatedAt.getTime() !== claim.claimedAt.getTime()) return false;
    await tx.update(toolInvocations).set({ status: "executing", startedAt: now, updatedAt: now })
      .where(eq(toolInvocations.id, invocationId));
    return true;
  });
}

export async function persistToolTestOutcome(db: Db, invocationId: string, outcome: ToolTestOutcome, claim?: ToolTestApprovalClaim) {
  const now = new Date();
  const values = { status: outcome.status, ...(outcome.result ? {
    resultHash: outcome.result.sha256 ?? null, resultSummary: outcome.result,
    resultSizeBytes: outcome.result.sizeBytes ?? null,
  } : {}), errorCode: outcome.errorCode, errorMessage: outcome.errorMessage, completedAt: now, updatedAt: now };
  if (!claim) {
    await db.update(toolInvocations).set(values).where(eq(toolInvocations.id, invocationId));
    return true;
  }
  return writeToolReviewChange(db, async tx => {
    const [invocation] = await tx.select({ status: toolInvocations.status }).from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(eq(toolActionRequests.id, claim.actionRequestId)).for("update");
    if (!invocation || !["awaiting_approval", "executing"].includes(invocation.status) ||
      request?.status !== "executing" || request.updatedAt.getTime() !== claim.claimedAt.getTime()) return false;
    await tx.update(toolInvocations).set(values).where(eq(toolInvocations.id, invocationId));
    await tx.update(toolActionRequests).set({ status: outcome.status === "succeeded" ? "executed" : "failed",
      resolvedAt: now, updatedAt: now }).where(eq(toolActionRequests.id, claim.actionRequestId));
    return true;
  });
}
