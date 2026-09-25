import type { RuntimeProgressSink } from "./runtime-progress.js";

type RestorePhase = "workspace" | "asset";
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EXDEV", "ENOTDIR", "EISDIR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

/** Only fixed codes and bounded numbers may enter the company-readable run log. */
function diagnostic(error: unknown): { errorCode: string; httpStatus?: number; exitCode?: number } {
  const result: { errorCode: string; httpStatus?: number; exitCode?: number } = { errorCode: "unknown" };
  let current = error;
  // SDKs wrap transport errors in a cause. Bound traversal, including cycles.
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as Record<string, unknown>;
    if (result.errorCode === "unknown" && typeof value.code === "string" && ERROR_CODES.has(value.code)) {
      result.errorCode = value.code;
    }
    const status = value.status ?? value.statusCode;
    if (result.httpStatus === undefined && typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      result.httpStatus = status;
    }
    const exitCode = value.exitCode ?? (typeof value.code === "number" ? value.code : undefined);
    if (result.exitCode === undefined && typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255) {
      result.exitCode = exitCode;
    }
    current = value.cause;
  }
  return result;
}

/** Add evidence without changing the thrown error, restore policy, or task ordering. */
export async function withWorkspaceRestoreDiagnostics<T>(
  phase: RestorePhase,
  operation: () => Promise<T>,
  onProgress?: RuntimeProgressSink,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      await onProgress?.(`[paperclip] Workspace restore diagnostic: ${JSON.stringify({ phase, ...diagnostic(error) })}\n`);
    } catch {
      // A broken log sink must not replace a restore failure or relax its safety classification.
    }
    throw error;
  }
}
