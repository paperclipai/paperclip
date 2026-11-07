import type { RuntimeProgressSink } from "./runtime-progress.js";
import { getWorkspaceRestoreDiagnostic, withWorkspaceRestoreDiagnosticCapture } from "./workspace-restore-diagnostics.js";
import {
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  isWorkspaceRestoreCancelled,
  type WorkspaceRestoreOutcome,
} from "./workspace-restore-merge.js";

/**
 * The one staged-runtime capability the teardown factory needs: restore the
 * sandbox workspace back onto the host.
 */
export interface WorkspaceRestoreTeardownRuntime {
  restoreWorkspace(onProgress?: RuntimeProgressSink, signal?: AbortSignal | null): Promise<void>;
}

/**
 * The ACP managed-home teardown step. The engine caches it with the staged
 * runtime and reuses it on compatible resumes, so each invocation passes the
 * CURRENT run's cancellation signal; the one captured at construction belongs
 * to the run that first built it and is only a fallback.
 */
export type WorkspaceRestoreTeardownStep = (signal?: AbortSignal | null) => Promise<WorkspaceRestoreOutcome>;

/**
 * Builds the shared ACP adapter teardown step. The Claude, Codex, and Gemini
 * adapters run the same five steps at teardown and differ only in two log
 * strings: the start message and the failure prefix. Give this factory the
 * staged runtime, the `onLog` sink, and those two strings; it returns the
 * teardown step.
 *
 * The returned step logs `startMessage` to `stdout`, restores the workspace,
 * and on success returns `{ ok: true }`. On a caught error, it classifies the
 * error into an allowlisted {@link WorkspaceRestoreOutcome} code, logs
 * `failurePrefix` plus the allowlisted diagnostic to `stderr`, and returns
 * `{ ok: false, code }`.
 */
export function createWorkspaceRestoreTeardown(input: {
  stagedRuntime: WorkspaceRestoreTeardownRuntime;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  startMessage: string;
  failurePrefix: string;
  /** Fallback run-scoped cancellation for callers that invoke the step without
   * one. A cached step outlives the run that built it, so the engine passes the
   * current run's signal on every call; that one wins over this. */
  signal?: AbortSignal | null;
}): WorkspaceRestoreTeardownStep {
  const { stagedRuntime, onLog, startMessage, failurePrefix, signal } = input;
  return (callSignal) => withWorkspaceRestoreDiagnosticCapture(async () => {
    const effectiveSignal = callSignal ?? signal ?? null;
    try {
      await onLog("stdout", startMessage);
      await stagedRuntime.restoreWorkspace((line) => onLog("stdout", line), effectiveSignal);
      return { ok: true };
    } catch (err) {
      // An operator Stop during the staged restore is a skip, not a
      // failure: report it on stdout (mirroring the CLI lanes) and let the
      // run's own stop path own the terminal state. The fail-soft contract
      // (never throw) is unchanged; the restore genuinely did not complete.
      if (isWorkspaceRestoreCancelled(err)) {
        await onLog("stdout", "[paperclip] Skipping workspace restore: run was cancelled.\n");
        return { ok: false, code: "restore_failed" };
      }
      // The run log is readable by any same-company actor, so it must never
      // carry the caught error's own message: that message can hold a host
      // filesystem path or a process id. Log only the fixed, allowlisted
      // diagnostic for the classified code.
      const code = classifyWorkspaceRestoreFailure(err);
      const diagnostic = getWorkspaceRestoreDiagnostic(err);
      await onLog("stderr", `${failurePrefix}: ${describeWorkspaceRestoreFailure(code)}\n`);
      return { ok: false, code, ...(diagnostic ? { diagnostic } : {}) };
    }
  });
}
