import type { ExecutionWorkspace } from "@paperclipai/shared";

/** Short-lived display cache only. Destructive operations must inspect afresh. */
export function createWorkspaceGitInspectionCache<T>(inspect: (workspace: ExecutionWorkspace) => Promise<T>) {
  const entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();
  return (workspace: ExecutionWorkspace): Promise<T> => {
    const key = JSON.stringify([
      workspace.companyId, workspace.id, workspace.updatedAt, workspace.providerType,
      workspace.providerRef, workspace.cwd, workspace.repoUrl, workspace.baseRef,
      workspace.branchName, workspace.metadata,
    ]);
    const now = Date.now();
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) return existing.promise;
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(candidate);
    }
    if (entries.size >= 256) entries.delete(entries.keys().next().value!);
    const entry = { expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve().then(() => inspect(workspace)) };
    entries.set(key, entry);
    entry.promise = entry.promise.then((result) => {
      entry.expiresAt = Date.now() + 5_000;
      return result;
    }, (error) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry.promise;
  };
}
