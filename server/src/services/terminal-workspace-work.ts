import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const TERMINAL_WORKSPACE_RETRY_MS = 5 * 60 * 1000;

export function notifyTerminalWorkspaceWork(transaction: object, hint?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.terminalWorkspaces, hint);
}

export function registerTerminalWorkspaceWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: {
    sweepTerminalWorkspaces(
      limit?: number,
      signal?: AbortSignal,
      options?: { compact?: boolean },
    ): Promise<{ checked: number }>;
    // The row janitor runs next to the terminal reaper, on the same queue and
    // the same deadline. It removes the rows that the reaper only archives.
    sweepStaleExecutionWorkspaceRows?(
      limit?: number,
      signal?: AbortSignal,
    ): Promise<{ checked: number; removed: number }>;
    nextExecutionWorkspaceRowJanitorAt?(): Promise<number | null>;
    nextTerminalWorkspaceSweepAt(): Promise<number | null>;
    hasTerminalWorkspaceSweepContinuation(): boolean;
    terminalWorkspaceWorkSettled?(hints?: ReadonlySet<string>): void;
  },
  canRun: () => boolean,
) {
  let next: number | null = Date.now();
  let recovered = false;
  // Server readiness waits for the first sweep. Compaction walks worktrees and
  // deletes dependency trees, which can take seconds per workspace and is never
  // needed to serve requests, so the first sweep skips it and later sweeps do it.
  let startupSweepStarted = false;
  const worker = coordinator.register(DELIVERY_QUEUES.terminalWorkspaces, {
    retryMs: TERMINAL_WORKSPACE_RETRY_MS,
    onSettled: service.terminalWorkspaceWorkSettled,
    run: signal => {
      recovered = false;
      next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      const compact = startupSweepStarted;
      startupSweepStarted = true;
      return service.sweepTerminalWorkspaces(50, signal, { compact }).then(async (sweepResult) => {
        const janitorResult = await service.sweepStaleExecutionWorkspaceRows?.(25, signal);
        return janitorResult
          ? { ...sweepResult, rowsRemoved: janitorResult.removed }
          : sweepResult;
      });
    },
    hasPending: async () => {
      if (!canRun()) next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      else if (service.hasTerminalWorkspaceSweepContinuation()) next = Date.now() + 1000;
      else {
        const deadline = await service.nextTerminalWorkspaceSweepAt();
        const janitorDeadline = await service.nextExecutionWorkspaceRowJanitorAt?.() ?? null;
        // The worker wakes for the earliest deadline of the two duties. When
        // neither duty has a deadline the worker stays quiet.
        const deadlines = [deadline, janitorDeadline].filter((value): value is number => value !== null);
        next = deadlines.length === 0 ? null : Math.min(...deadlines);
        if (next !== null && next <= Date.now()) next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
        recovered = true;
      }
      return false;
    },
    nextRunAt: () => next,
  });
  return { ...worker, hasUnrecoveredWork: () => !recovered };
}
