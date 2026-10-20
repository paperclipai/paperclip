import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { z } from "zod";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";

export const workspaceRecoverySchema = z.object({
  schema: z.literal("paperclip.workspace-recovery.v1"),
  runId: z.string().guid(),
  status: z.enum(["queued", "recovering", "blocked", "recovered"]),
  stage: z.enum(["verifying_stop", "restoring_files", "saving_receipts"]),
  attempt: z.number().int().nonnegative(),
  attemptLimit: z.number().int().positive().optional(),
  blockerCode: z.enum(["stop", "source", "owner", "writer"]).optional(),
  requestIds: z.array(z.string().guid()),
  retryAt: z.number().optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional(),
});
export type WorkspaceRecovery = z.infer<typeof workspaceRecoverySchema>;
export function readWorkspaceRecovery(evidence: Record<string, unknown> | null) {
  const parsed = workspaceRecoverySchema.safeParse(evidence?.workspaceRecovery);
  return parsed.success ? parsed.data : null;
}
export function workspaceRecoveryDisplay(evidence: Record<string, unknown>, runId: string | null): ExecutionBlocker["workspaceRecovery"] {
  const state = readWorkspaceRecovery(evidence);
  if (!state || state.runId !== runId) return undefined;
  return { status: state.status, stage: state.stage,
    canRetry: state.status === "blocked" && state.retryable === true,
    message: state.status === "queued" || state.status === "recovering" ? "Recovering saved work…"
      : state.status === "recovered" ? "Saved work recovered. Send a message to continue."
        : state.message ?? "Paperclip couldn’t safely recover this task. This task needs service attention.",
  };
}

/** Only the host writes workspace operations. Adapter output and a user-supplied
 * repair note cannot substitute for this exact copyback receipt. Stop/authority
 * are checked separately at every continuation admission. */
export async function hasVerifiedWorkspaceRepair(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "issueId" | "contextSnapshot" | "runnerProfileJson">) {
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (typeof issueId !== "string" || !reference || reference.state !== "finalized" || !reference.finalHostSha256) return false;
  const [receipt] = await db.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.issueId, issueId),
    eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.phase, "workspace_recovery"),
    eq(workspaceOperations.status, "succeeded"),
  )).limit(1);
  const proof = receipt?.metadata;
  if (!proof || proof.leaseId !== reference.leaseId || proof.providerLeaseId !== reference.providerLeaseId
    || proof.descriptorSha256 !== reference.descriptorSha256 || proof.finalHostSha256 !== reference.finalHostSha256
    || typeof proof.recoveryActionId !== "string") return false;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.id, proof.recoveryActionId),
  )).limit(1);
  const state = readWorkspaceRecovery(action?.evidence ?? null);
  return state?.runId === run.id && state.status === "recovered";
}
