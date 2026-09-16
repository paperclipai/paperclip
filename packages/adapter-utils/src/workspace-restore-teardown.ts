import type { RuntimeProgressSink } from "./runtime-progress.js";
import {
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  type WorkspaceRestoreOutcome,
} from "./workspace-restore-merge.js";

/**
 * The one staged-runtime capability the teardown factory needs: restore the
 * sandbox workspace back onto the host.
 */
export interface WorkspaceRestoreTeardownRuntime {
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

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
}): () => Promise<WorkspaceRestoreOutcome> {
  const { stagedRuntime, onLog, startMessage, failurePrefix } = input;
  return async () => {
    try {
      await onLog("stdout", startMessage);
      await stagedRuntime.restoreWorkspace((line) => onLog("stdout", line));
      return { ok: true };
    } catch (err) {
      // The run log is readable by any same-company actor, so it must never
      // carry the caught error's own message: that message can hold a host
      // filesystem path or a process id. Log only the fixed, allowlisted
      // diagnostic for the classified code.
      const code = classifyWorkspaceRestoreFailure(err);
      await onLog("stderr", `${failurePrefix}: ${describeWorkspaceRestoreFailure(code)}\n`);
      return { ok: false, code };
    }
  };
}
