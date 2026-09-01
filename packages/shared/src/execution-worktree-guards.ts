import type { ExecutionWorktree } from "./types/worktree-runtime.js";

type ExecutionWorktreeGuardTarget = Pick<ExecutionWorktree, "closedAt" | "mode" | "name" | "status">;

const CLOSED_EXECUTION_WORKSPACE_STATUSES = new Set<ExecutionWorktree["status"]>(["archived", "cleanup_failed"]);

export function isClosedIsolatedExecutionWorktree(
  worktree: Pick<ExecutionWorktreeGuardTarget, "closedAt" | "mode" | "status"> | null | undefined,
): boolean {
  if (!worktree) return false;
  if (worktree.mode !== "isolated_workspace") return false;
  return worktree.closedAt != null || CLOSED_EXECUTION_WORKSPACE_STATUSES.has(worktree.status);
}

export function getClosedIsolatedExecutionWorktreeMessage(
  worktree: Pick<ExecutionWorktreeGuardTarget, "name">,
): string {
  return `This issue is linked to the closed worktree "${worktree.name}". Move it to an open worktree before adding comments or resuming work.`;
}
