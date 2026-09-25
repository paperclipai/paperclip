import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeProgressSink } from "./runtime-progress.js";

type RestorePhase = "workspace" | "asset";
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EXDEV", "ENOTDIR", "EISDIR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
const activeDiagnostic = new AsyncLocalStorage<boolean>();

function readField(value: Record<string, unknown>, key: string): unknown {
  try { return value[key]; } catch { return undefined; }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value : undefined;
}

/** Only fixed codes and bounded numbers may enter the company-readable run log. */
function diagnostic(error: unknown): { errorCode: string; httpStatus?: number; exitCode?: number } {
  const result: { errorCode: string; httpStatus?: number; exitCode?: number } = { errorCode: "unknown" };
  let current = error;
  // SDKs wrap transport errors in a cause. Bound traversal, including cycles.
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as Record<string, unknown>;
    const code = readField(value, "code");
    if (result.errorCode === "unknown" && typeof code === "string" && ERROR_CODES.has(code)) {
      result.errorCode = code;
    }
    const status = boundedInteger(readField(value, "status"), 400, 599)
      ?? boundedInteger(readField(value, "statusCode"), 400, 599);
    if (result.httpStatus === undefined && status !== undefined) {
      result.httpStatus = status;
    }
    const exitCode = boundedInteger(readField(value, "exitCode"), 1, 255) ?? boundedInteger(code, 1, 255);
    if (result.exitCode === undefined && exitCode !== undefined) {
      result.exitCode = exitCode;
    }
    current = readField(value, "cause");
  }
  return result;
}

/** Add evidence without changing the thrown error, restore policy, or task ordering. */
export async function withWorkspaceRestoreDiagnostics<T>(
  phase: RestorePhase,
  operation: () => Promise<T>,
  onProgress?: RuntimeProgressSink,
): Promise<T> {
  // A nested repository restore propagates to its enclosing workspace task.
  // That task owns the diagnostic. Independent parallel tasks retain their own
  // async scopes, so two failed tasks still produce two diagnostic lines.
  if (activeDiagnostic.getStore()) return await operation();
  return await activeDiagnostic.run(true, async () => {
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
  });
}
