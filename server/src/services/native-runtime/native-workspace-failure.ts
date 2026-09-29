import { classifyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-merge";

export type NativeWorkspaceFailureCode =
  | "workspace_sync_out_failed"
  | "workspace_sync_out_unrecoverable"
  | "workspace_sync_out_unsafe_archive";

/** Keep initial and recovered copy-back failures on the same retry policy. */
export function classifyNativeWorkspaceFailure(error: unknown): {
  code: NativeWorkspaceFailureCode;
  failureCode: `native_${NativeWorkspaceFailureCode}`;
  permanent: boolean;
} {
  const message = error instanceof Error ? error.message.trim() : "";
  const code: NativeWorkspaceFailureCode =
    message === "workspace_sync_out_unrecoverable" || message.includes("daytona_sandbox_not_found")
      ? "workspace_sync_out_unrecoverable"
      : message === "workspace_sync_out_unsafe_archive" || classifyWorkspaceRestoreFailure(error) === "restore_unsafe_archive"
        ? "workspace_sync_out_unsafe_archive"
        : "workspace_sync_out_failed";
  return { code, failureCode: `native_${code}`, permanent: code !== "workspace_sync_out_failed" };
}
