export const PERSISTED_WORKSPACE_SOURCE_REASON_CODES = [
  "source_scope_mismatch", "explicit_project_workspace_conflict", "source_path_unproven",
  "source_registration_unproven", "source_repository_mismatch", "source_repository_unavailable",
] as const;

export type PersistedWorkspaceSourceReasonCode = typeof PERSISTED_WORKSPACE_SOURCE_REASON_CODES[number];

export const MANAGED_GIT_WORKTREE_REASON_CODES = [
  "missing_worktree", "not_a_git_checkout", "not_registered",
  "wrong_repository_root", "branch_mismatch", "git_inspection_failed",
] as const;

export type ManagedGitInspectionDiagnostic = {
  command: "worktree_list";
  failure: "spawn_failed" | "nonzero_exit" | "output_truncated";
  errorCode?: "EACCES" | "ENOENT" | "EIO" | "EMFILE" | "ENFILE" | "ENOMEM" | "EPERM" | "unknown";
  exitCode?: number;
};

function read(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

/** Keep command output, paths, arguments and arbitrary error properties out of reports. */
export function readManagedGitInspectionDiagnostic(value: unknown): ManagedGitInspectionDiagnostic | null {
  if (read(value, "command") !== "worktree_list") return null;
  const failure = read(value, "failure");
  if (failure !== "spawn_failed" && failure !== "nonzero_exit" && failure !== "output_truncated") return null;
  const result: ManagedGitInspectionDiagnostic = { command: "worktree_list", failure };
  if (failure === "spawn_failed") {
    const code = read(value, "errorCode");
    result.errorCode = code === "EACCES" || code === "ENOENT" || code === "EIO" || code === "EMFILE"
      || code === "ENFILE" || code === "ENOMEM" || code === "EPERM" ? code : "unknown";
  }
  if (failure === "nonzero_exit") {
    const code = read(value, "exitCode");
    if (typeof code === "number" && Number.isInteger(code) && code >= 1 && code <= 255) result.exitCode = code;
  }
  return result;
}
