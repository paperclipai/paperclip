import type { Db } from "@paperclipai/db";
import type { WorkspaceSourceInspection } from "@paperclipai/shared";
import { inspectWorkspaceRecoverySource, WorkspaceSourceInspectionLimit,
  type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";
import { SystemRecoveryFailure, workspaceSourceVerificationFailureSchema } from "./system-recovery-state.js";

export const MAX_INSPECTED_WORKSPACE_SOURCES = 8;

export async function inspectWorkspaceSource(db: Db, input: WorkspaceRecoverySourceIdentity): Promise<WorkspaceSourceInspection> {
  const base = { schema: "paperclip.workspace-source-inspection.v1" as const, actionId: input.actionId,
    runId: input.runId, observedAt: new Date().toISOString(), scope: "recorded_source_identity" as const };
  try {
    await inspectWorkspaceRecoverySource(db, input, { maximumSources: MAX_INSPECTED_WORKSPACE_SOURCES });
    return { ...base, status: "verified" };
  } catch (error) {
    if (error instanceof WorkspaceSourceInspectionLimit) return { ...base, status: "not_inspected", reason: "source_limit" };
    if (!(error instanceof SystemRecoveryFailure)) throw error;
    const detail = workspaceSourceVerificationFailureSchema.safeParse(error.sourceVerification);
    return { ...base, status: "blocked", failureCode: error.code,
      ...(detail.success ? { sourceVerification: detail.data } : {}) };
  }
}
