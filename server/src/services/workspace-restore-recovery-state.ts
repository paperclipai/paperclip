import type { heartbeatRuns } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";

export const LEGACY_WORKSPACE_RECOVERY_KEY = "workspaceRestoreRecovery";
export const LEGACY_WORKSPACE_RECOVERY_SCHEMA = "paperclip.workspace-restore-recovery.v1";

/** The admitted external contract can prohibit workspace access even though its
 * managed Runner has a synchronization descriptor for durable recovery. That
 * descriptor alone does not create a user-file export obligation. */
export function nativeRunHasNoWorkspaceAccess(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "runtimeMode" | "driverKind" | "runnerProfileJson">): boolean {
  const input = run.runnerProfileJson?.nativeExecutionInput as Record<string, unknown> | undefined;
  if (run.runtimeMode !== "native" || !input || (input.schema !== "paperclip.native-execution-input.v6" && input.schema !== "paperclip.native-execution-input.v8")) return false;
  const binding = input.binding as Record<string, unknown> | undefined;
  const workspace = input.workspace as Record<string, unknown> | undefined;
  const provider = input.provider as Record<string, unknown> | undefined;
  const driver = input?.schema === "paperclip.native-execution-input.v8"
    ? provider?.kind === "muse" && provider.bridgeRevision === "muse-v1" ? "muse_external" : null
    : provider?.kind === "grok_bot" ? "grok_bot_mcp"
      : provider?.kind === "openai_dot" ? "openai_dot_mcp" : null;
  return driver !== null && run.driverKind === driver && workspace?.access === "none" && workspace.cwd === null
    && binding?.runId === run.id && binding.companyId === run.companyId && binding.agentId === run.agentId
    && binding.issueId === (run.nativeIssueId ?? run.issueId);
}

export function hasRequiredWorkspaceRecovery(result: Record<string, unknown> | null | undefined): boolean {
  const value = result?.[LEGACY_WORKSPACE_RECOVERY_KEY];
  return hasWorkspaceRestoreFailure(result) && !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === LEGACY_WORKSPACE_RECOVERY_SCHEMA;
}



/** Late adapter/projection writes cannot certify recovery or remove its pin. */
export function preserveWorkspaceRestoreRecoveryMetadata(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return hasRequiredWorkspaceRecovery(current) ? { ...incoming,
    workspaceRestoreFailure: current!.workspaceRestoreFailure,
    workspaceRestoreRecovery: current!.workspaceRestoreRecovery,
  } : incoming;
}
