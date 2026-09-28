/** Closed, path-free classifications persisted by adapter settlement. */
export const WORKSPACE_RESTORE_FAILURE_CODES = [
  "restore_permission_denied",
  "restore_lock_timeout",
  "restore_unsafe_archive",
  "restore_failed",
] as const;

export function hasWorkspaceRestoreFailure(result: Record<string, unknown> | null | undefined): boolean {
  return WORKSPACE_RESTORE_FAILURE_CODES.some((code) => result?.workspaceRestoreFailure === code);
}

/** Display only ordinary repository paths, never targets, host paths or temp IDs. */
export function safeWorkspaceRestorePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 180) return null;
  const relative = value.replace(/^\.\//, "");
  if (!relative || !/^[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.startsWith("/")) return null;
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  if (/(?:[a-f0-9]{8}-[a-f0-9-]{27,}|[a-zA-Z0-9_-]{32,}|(?:^|\/)(?:tmp|temp|paperclip-clone)[^/]*)(?:\/|$)/i.test(relative)) return null;
  return relative;
}
