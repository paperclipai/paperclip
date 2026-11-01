import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike, type IssueRecoveryAction } from "@paperclipai/shared";
import { nativeSha256 } from "./canonical.js";

export const NATIVE_WORKSPACE_OWNER_UNVERIFIED = "native_workspace_finalization_owner_unverified";

export function hasNativeWorkspaceFinalizationOwner(profile: Record<string, unknown> | null | undefined): boolean {
  return profile?.nativeWorkspaceFinalizationOwner != null;
}

/** A terminal task does not prove that an older controller's copyback stopped. */
export async function hasUnverifiedNativeWorkspaceFinalizationOwner(
  db: Db,
  action: Pick<IssueRecoveryAction, "companyId" | "sourceIssueId" | "cause" | "fingerprint" | "evidence">,
): Promise<boolean> {
  if (action.cause !== NATIVE_WORKSPACE_OWNER_UNVERIFIED) return false;
  const runId = action.evidence?.runId;
  if (typeof runId !== "string" || !isUuidLike(runId)) return false;
  const [run] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, action.companyId),
    eq(heartbeatRuns.id, runId),
    eq(heartbeatRuns.nativeIssueId, action.sourceIssueId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
  const owner = run?.profile?.nativeWorkspaceFinalizationOwner;
  return hasNativeWorkspaceFinalizationOwner(run?.profile) && action.fingerprint === nativeSha256({ runId, owner });
}
