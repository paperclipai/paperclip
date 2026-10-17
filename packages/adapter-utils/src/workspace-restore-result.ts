import { hasWorkspaceRestoreFailure, safeWorkspaceRestorePath } from "@paperclipai/shared";
import type { AdapterExecutionResult } from "./types.js";
import { classifyWorkspaceRestoreFailure } from "./workspace-restore-merge.js";
import { getWorkspaceRestoreDiagnostic, withWorkspaceRestoreDiagnosticCapture } from "./workspace-restore-diagnostics.js";

/** A terminal provider result that is safe to discard after restore succeeds. */
export function canDiscardRestoredRunWorkspace(result: AdapterExecutionResult | null): boolean {
  return result !== null && result.exitCode === 0 && result.signal === null && !result.timedOut
    && !result.errorCode && !result.errorMessage && !hasWorkspaceRestoreFailure(result.resultJson);
}

/** Call only after workspace and asset restore completed without throwing. */
export async function cleanupRestoredRunWorkspace(input: {
  cleanup: (() => Promise<void>) | null | undefined;
  result: AdapterExecutionResult | null;
  providerStopped: boolean;
  collectionSucceeded: boolean;
  cancelled: boolean;
  onFailure: () => Promise<void> | void;
}): Promise<void> {
  if (!input.cleanup || !input.providerStopped || !input.collectionSucceeded || input.cancelled ||
      !canDiscardRestoredRunWorkspace(input.result)) return;
  try {
    await input.cleanup();
  } catch {
    // A failed delete or a failed diagnostic must never replace the run result.
    await Promise.resolve().then(input.onFailure).catch(() => {});
  }
}

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
  return withWorkspaceRestoreDiagnosticCapture(async () => {
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
      const diagnostic = getWorkspaceRestoreDiagnostic(error);
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
          ...(diagnostic ? { workspaceRestoreDiagnostic: diagnostic } : {}),
          ...(relativePath ? { workspaceRestorePath: relativePath } : {}),
        },
      });
    }
    if (executionThrew) throw executionError;
    return result!;
  });
}
