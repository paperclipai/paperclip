import type { WorktreeRuntimeControlTarget } from "@paperclipai/shared";

export function sanitizeWorktreeRuntimeControlTarget(
  target: WorktreeRuntimeControlTarget = {},
): WorktreeRuntimeControlTarget {
  return {
    workspaceCommandId: target.workspaceCommandId ?? null,
    runtimeServiceId: target.runtimeServiceId ?? null,
    serviceIndex: target.serviceIndex ?? null,
  };
}
