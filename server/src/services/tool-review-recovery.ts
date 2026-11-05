import { and, asc, eq, gt } from "drizzle-orm";
import { approvals, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";

import { readSignedToolArgumentsPayload } from "./tool-content-guards.js";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";

type ReviewProjection = {
  actionRequestId: string;
  status: "executed" | "executing" | "failed" | "cancelled";
  errorCode?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
};

/** Reconcile saved history before dispatch; never infer a safe provider replay. */
export async function prepareApprovedToolReview(db: Db, input: {
  actionRequestId: string;
  invocationId: string;
  signingSecret?: string;
}) {
  return db.transaction(async tx => {
    // Match Test-tab claims/outcome persistence. Recheck after the locks because
    // a foreground approval may have claimed the row since the recovery scan.
    const [invocation] = await tx.select().from(toolInvocations)
      .where(eq(toolInvocations.id, input.invocationId)).for("update");
    const [request] = await tx.select().from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.invocationId, input.invocationId))).for("update");
    if (!invocation || request?.status !== "approved") return { kind: "skip" } as const;
    const now = new Date();

    async function settle(projection: ReviewProjection, failure?: {
      status: "failed" | "denied";
      errorCode: string;
      errorMessage: string;
    }) {
      await notifyToolReviewChange(tx, request.companyId);
      if (failure) await tx.update(toolInvocations).set({ ...failure, completedAt: now, updatedAt: now })
        .where(eq(toolInvocations.id, invocation.id));
      await tx.update(toolActionRequests).set({ status: projection.status,
        ...(projection.status === "executing"
          ? { updatedAt: invocation.startedAt ?? invocation.updatedAt }
          : { resolvedAt: invocation.completedAt ?? now, updatedAt: now }),
      }).where(eq(toolActionRequests.id, request.id));
      return { kind: "settled", projection } as const;
    }
    function fail(status: "failed" | "cancelled", invocationStatus: "failed" | "denied", errorCode: string, errorMessage: string) {
      return settle({ actionRequestId: request.id, status, errorCode, errorMessage },
        { status: invocationStatus, errorCode, errorMessage });
    }
    if (invocation.companyId !== request.companyId) {
      // Quarantine the request without modifying another company's invocation.
      return settle({ actionRequestId: request.id, status: "failed",
        errorCode: "action_context_mismatch", errorMessage: "Tool action and invocation companies do not match." });
    }
    if (["succeeded", "failed", "denied", "cancelled", "timed_out", "rate_limited", "executing"].includes(invocation.status)) {
      return settle({ actionRequestId: request.id,
        status: invocation.status === "succeeded" ? "executed"
          : invocation.status === "executing" ? "executing"
          : invocation.status === "cancelled" ? "cancelled" : "failed",
        errorCode: invocation.errorCode, errorMessage: invocation.errorMessage,
        resultSummary: invocation.resultSummary?.summary });
    }
    if (invocation.status !== "awaiting_approval") {
      return fail("failed", "failed", "tool_recovery_state_invalid",
        "Approved action has inconsistent invocation history. Inspect the provider before retrying; recovery did not replay it.");
    }

    // Missing-key/configuration errors deliberately propagate as retryable;
    // only a decoded invalid signature is a permanent request failure.
    const payload = readSignedToolArgumentsPayload({ signedArguments: request.signedArguments,
      invocationId: invocation.id, toolName: invocation.toolName, signingSecret: input.signingSecret });
    if (!payload) return fail("cancelled", "failed", "action_request_invalidated",
      "Stored tool arguments are no longer verifiable; submit a new action for review.");
    if (request.approvalId) {
      const [formal] = await tx.select({ status: approvals.status }).from(approvals)
        .where(and(eq(approvals.id, request.approvalId), eq(approvals.companyId, request.companyId)));
      if (!formal || formal.status === "rejected" || formal.status === "cancelled") {
        return fail("cancelled", "denied", "formal_approval_unavailable",
          "Required formal board approval is unavailable or was declined; submit a new action for review.");
      }
      // Human input has no deadline. The approval owner publishes a committed
      // resolution/cancellation to this queue; startup also rediscovers the row.
      if (formal.status === "pending" || formal.status === "revision_requested") {
        return { kind: "skip" } as const;
      }
    }
    return { kind: "ready", request, invocation, payload } as const;
  });
}

export function approvedToolReviewCompanies(db: Db, companyId?: string) {
  return db.select({ companyId: toolActionRequests.companyId }).from(toolActionRequests)
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
    .where(and(eq(toolActionRequests.status, "approved"),
      companyId ? eq(toolActionRequests.companyId, companyId) : undefined))
    .groupBy(toolActionRequests.companyId);
}

export async function recoverApprovedToolReviews(db: Db, recover: (input: {
  request: typeof toolActionRequests.$inferSelect;
  invocation: typeof toolInvocations.$inferSelect;
}) => Promise<boolean>, companyId?: string) {
  let cursor: string | undefined;
  let scanned = 0, retry = false;
  for (;;) {
    const rows = await db.select({ request: toolActionRequests, invocation: toolInvocations })
      .from(toolActionRequests).innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(eq(toolActionRequests.status, "approved"),
        companyId ? eq(toolActionRequests.companyId, companyId) : undefined,
        cursor ? gt(toolActionRequests.id, cursor) : undefined))
      .orderBy(asc(toolActionRequests.id)).limit(100);
    for (const row of rows) retry = await recover(row) || retry;
    scanned += rows.length;
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].request.id;
  }
  return { scanned, retry };
}
