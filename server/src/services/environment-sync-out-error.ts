import { readEnvironmentSyncErrorDiagnostic } from "@paperclipai/plugin-sdk";
import { preserveWorkspaceRestoreErrorDiagnostic } from "@paperclipai/adapter-utils/workspace-restore-diagnostics";

/** Keep the original RPC failure and policy fields; add only private diagnostic evidence. */
export function preserveEnvironmentSyncOutErrorDiagnostic(error: unknown): unknown {
  const diagnostic = readEnvironmentSyncErrorDiagnostic(error);
  if (diagnostic && error && typeof error === "object") {
    preserveWorkspaceRestoreErrorDiagnostic(error, {
      code: diagnostic.errorCode,
      status: diagnostic.httpStatus,
      exitCode: diagnostic.exitCode,
    });
  }
  return error;
}
