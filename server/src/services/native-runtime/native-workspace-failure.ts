import { classifyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL_CODE } from "../remote-workspace-transport.js";

export type NativeWorkspaceFailureCode =
  | "workspace_sync_out_failed"
  | "workspace_sync_out_unrecoverable"
  | "workspace_sync_out_unsafe_archive";

export type WorkspaceSaveRestCause =
  | "sandbox_disk_full"
  | "git_operation_in_progress";

export const REMOTE_WORKSPACE_GIT_OPERATION_IN_PROGRESS_CODE =
  "remote_workspace_archive_git_operation_in_progress";

function readFailureText(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value instanceof Error
      ? value.message.trim()
      : "";
}

/**
 * A workspace with an unfinished Git operation (such as a conflicted merge or
 * rebase) fails every copy-back attempt the same way: nothing finishes or
 * aborts the Git operation between automatic attempts.
 */
export function isWorkspaceGitOperationInProgress(value: unknown): boolean {
  const text = readFailureText(value);
  return text === REMOTE_WORKSPACE_GIT_OPERATION_IN_PROGRESS_CODE
    || text.startsWith(`${REMOTE_WORKSPACE_GIT_OPERATION_IN_PROGRESS_CODE}:`);
}

/**
 * Deterministic workspace-save refusals that repeat identically across
 * automatic attempts because the sandbox state does not change between tries.
 */
export function workspaceSaveRestCause(value: unknown): WorkspaceSaveRestCause | null {
  const text = readFailureText(value);
  if (text.startsWith(`${REMOTE_WORKSPACE_SANDBOX_DISK_FULL_CODE}:`)) return "sandbox_disk_full";
  if (isWorkspaceGitOperationInProgress(text)) return "git_operation_in_progress";
  return null;
}

/** Keep initial and recovered copy-back failures on the same retry policy. */
export function classifyNativeWorkspaceFailure(error: unknown): {
  code: NativeWorkspaceFailureCode;
  failureCode: `native_${NativeWorkspaceFailureCode}`;
  permanent: boolean;
} {
  const message = readFailureText(error);
  const code: NativeWorkspaceFailureCode =
    message === "workspace_sync_out_unrecoverable" || message.includes("daytona_sandbox_not_found")
      || classifyWorkspaceRestoreFailure(error) === "restore_invalid_metadata"
      ? "workspace_sync_out_unrecoverable"
      : message === "workspace_sync_out_unsafe_archive" || classifyWorkspaceRestoreFailure(error) === "restore_unsafe_archive"
        ? "workspace_sync_out_unsafe_archive"
        : "workspace_sync_out_failed";
  return { code, failureCode: `native_${code}`, permanent: code !== "workspace_sync_out_failed" };
}
