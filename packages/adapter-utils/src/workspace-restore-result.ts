import { hasWorkspaceRestoreFailure, safeWorkspaceRestorePath } from "@paperclipai/shared";
import type { AdapterExecutionResult } from "./types.js";
import { classifyWorkspaceRestoreFailure } from "./workspace-restore-merge.js";

/** A completed model turn does not imply that required workspace files arrived. */
export function applyWorkspaceRestoreFailure(result: AdapterExecutionResult): AdapterExecutionResult {
  if (!hasWorkspaceRestoreFailure(result.resultJson) || result.errorCode === "workspace_restore_failed") return result;
  return {
    ...result,
    timedOut: false,
    errorCode: "workspace_restore_failed",
    errorMessage: [result.errorMessage, "Workspace restore failed. Workspace files need recovery."].filter(Boolean).join(" "),
    resultJson: {
      ...result.resultJson,
      executionBeforeRestore: {
        errorCode: result.errorCode ?? null,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      },
      finalResponseRecorded: typeof result.resultJson?.finalResponseRecorded === "boolean"
        ? result.resultJson.finalResponseRecorded : Boolean(result.summary?.trim()),
    },
  };
}

/** Preserve a pending result (or earlier error) when copy-back fails. */
export async function withWorkspaceRestore(
  execute: () => Promise<AdapterExecutionResult>,
  restore: () => Promise<void>,
): Promise<AdapterExecutionResult> {
  let result: AdapterExecutionResult | undefined;
  let executionError: unknown;
  let executionThrew = false;
  try {
    result = await execute();
  } catch (error) {
    executionError = error;
    executionThrew = true;
  }
  try {
    await restore();
  } catch (error) {
    const code = classifyWorkspaceRestoreFailure(error);
    // Parse the archive member only. Never expose the unsafe link target.
    const member = error instanceof Error
      ? /Daytona syncOut refusing tarball link whose target escapes the extraction dir: (.+?) -> /.exec(error.message)?.[1]
      : null;
    const relativePath = safeWorkspaceRestorePath(member);
    return applyWorkspaceRestoreFailure({
      ...(result ?? {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "adapter_failed",
        // The server applies its ordinary execution-error redaction to this field.
        errorMessage: executionError instanceof Error ? executionError.message : "Adapter execution failed.",
      }),
      resultJson: {
        ...result?.resultJson,
        workspaceRestoreFailure: code,
        ...(relativePath ? { workspaceRestorePath: relativePath } : {}),
      },
    });
  }
  if (executionThrew) throw executionError;
  return result!;
}
