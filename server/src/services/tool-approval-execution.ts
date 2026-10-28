import { and, eq } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import type { ToolRedactedValueSummary } from "@paperclipai/shared";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";

export type ToolApprovalClaim = { actionRequestId: string; invocationId: string; claimedAt: Date };
export type ToolTestOutcome = {
  status: "succeeded" | "failed" | "timed_out" | "rate_limited";
  result?: ToolRedactedValueSummary;
  errorCode?: string;
  errorMessage?: string;
};

export async function claimToolTestApproval(db: Db, actionRequestId: string, invocationId: string): Promise<ToolApprovalClaim | null> {
  return db.transaction(async tx => {
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, actionRequestId), eq(toolActionRequests.invocationId, invocationId))).for("update");
    if (!invocation || request?.status !== "approved") return null;
    await notifyToolReviewChange(tx, request.companyId);
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

/** Return only this still-undispatched claim to its existing approval queue. */
export async function releaseToolApproval(db: Db, claim: ToolApprovalClaim) {
  return db.transaction(async tx => {
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, claim.invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, claim.actionRequestId),
        eq(toolActionRequests.invocationId, claim.invocationId))).for("update");
    if (invocation?.status !== "awaiting_approval" || invocation.startedAt !== null ||
      request?.status !== "executing" || request.companyId !== invocation.companyId ||
      request.updatedAt.getTime() !== claim.claimedAt.getTime()) return false;
    await notifyToolReviewChange(tx, request.companyId);
    await tx.update(toolActionRequests).set({ status: "approved", updatedAt: new Date() })
      .where(eq(toolActionRequests.id, request.id));
    return true;
  });
}

export async function bindVerifiedToolApprovalArguments(db: Db, claim: ToolApprovalClaim, hashes: { preview: string; verified: string }) {
  return db.transaction(async tx => {
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, claim.invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, claim.actionRequestId),
        eq(toolActionRequests.invocationId, claim.invocationId))).for("update");
    if (invocation?.status !== "awaiting_approval" || invocation.startedAt !== null ||
      request?.status !== "executing" || request.companyId !== invocation.companyId ||
      request.updatedAt.getTime() !== claim.claimedAt.getTime() ||
      ![hashes.preview, hashes.verified].includes(request.canonicalArgumentsHash) ||
      ![hashes.preview, hashes.verified].includes(invocation.argumentsHash ?? "")) return false;
    if (invocation.argumentsHash !== hashes.verified) await tx.update(toolInvocations)
      .set({ argumentsHash: hashes.verified, updatedAt: new Date() }).where(eq(toolInvocations.id, claim.invocationId));
    return true;
  });
}

export async function startToolInvocation(db: Db, invocationId: string, claim?: ToolApprovalClaim) {
  const now = new Date();
  if (!claim) {
    await db.update(toolInvocations).set({ status: "executing", startedAt: now, updatedAt: now })
      .where(eq(toolInvocations.id, invocationId));
    return true;
  }
  return db.transaction(async tx => {
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(eq(toolActionRequests.id, claim.actionRequestId)).for("update");
    if (invocationId !== claim.invocationId || invocation?.status !== "awaiting_approval" || invocation.startedAt !== null ||
      request?.status !== "executing" || request.invocationId !== invocationId || request.companyId !== invocation.companyId ||
      request.updatedAt.getTime() !== claim.claimedAt.getTime()) return false;
    await tx.update(toolInvocations).set({ status: "executing", approvalState: "approved", startedAt: now, updatedAt: now })
      .where(eq(toolInvocations.id, invocationId));
    return true;
  });
}

export async function persistToolTestOutcome(db: Db, invocationId: string, outcome: ToolTestOutcome, claim?: ToolApprovalClaim) {
  const now = new Date();
  const values = { status: outcome.status, ...(outcome.result ? {
    resultHash: outcome.result.sha256 ?? null, resultSummary: outcome.result,
    resultSizeBytes: outcome.result.sizeBytes ?? null,
  } : {}), errorCode: outcome.errorCode, errorMessage: outcome.errorMessage, completedAt: now, updatedAt: now };
  if (!claim) {
    await db.update(toolInvocations).set(values).where(eq(toolInvocations.id, invocationId));
    return true;
  }
  return db.transaction(async tx => {
    const [invocation] = await tx.select({ status: toolInvocations.status }).from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(eq(toolActionRequests.id, claim.actionRequestId)).for("update");
    if (!invocation || !["awaiting_approval", "executing"].includes(invocation.status) ||
      request?.status !== "executing" || request.updatedAt.getTime() !== claim.claimedAt.getTime()) return false;
    await notifyToolReviewChange(tx, request.companyId);
    await tx.update(toolInvocations).set(values).where(eq(toolInvocations.id, invocationId));
    await tx.update(toolActionRequests).set({ status: outcome.status === "succeeded" ? "executed" : "failed",
      resolvedAt: now, updatedAt: now }).where(eq(toolActionRequests.id, claim.actionRequestId));
    return true;
  });
}
