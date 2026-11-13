import { readEnvironmentSyncErrorDiagnostic, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { preserveWorkspaceRestoreErrorDiagnostic } from "@paperclipai/adapter-utils/workspace-restore-diagnostics";

/** Keep the original RPC failure and policy fields; add only private diagnostic evidence. */
export function preserveEnvironmentSyncOutErrorDiagnostic(error: unknown): unknown {
  const diagnostic = readEnvironmentSyncErrorDiagnostic(error);
  const rpcCode = error instanceof JsonRpcCallError && (Object.values(PLUGIN_RPC_ERROR_CODES) as number[]).includes(error.code)
    ? error.code : undefined;
  if ((diagnostic || rpcCode !== undefined) && error && typeof error === "object") {
    preserveWorkspaceRestoreErrorDiagnostic(error, {
      code: diagnostic?.errorCode,
      status: diagnostic?.httpStatus,
      exitCode: diagnostic?.exitCode,
    }, { ...diagnostic, rpcCode });
  }
  return error;
}
