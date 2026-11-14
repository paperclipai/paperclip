import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const TERMINAL_WORKSPACE_RETRY_MS = 5 * 60 * 1000;
export const MAX_TERMINAL_WORKSPACE_TARGETS = 50;

export function notifyTerminalWorkspaceWork(transaction: object, hint?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.terminalWorkspaces, hint);
}

export type TerminalWorkspaceTargets = { workspaceIds: string[]; issueIds: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function terminalWorkspaceTargetsFromHints(hints?: ReadonlySet<string>): TerminalWorkspaceTargets | null {
  if (!hints || hints.size === 0) return null;
  const targets: TerminalWorkspaceTargets = { workspaceIds: [], issueIds: [] };
  for (const hint of hints) {
    const [kind, id] = hint.split(":", 2);
    if (!id || !UUID.test(id) || `${kind}:${id}` !== hint) return null;
    if (kind === "workspace") targets.workspaceIds.push(id);
    else if (kind === "issue") targets.issueIds.push(id);
    else return null;
  }
  return targets;
}

export function registerTerminalWorkspaceWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: {
    sweepTerminalWorkspaces(
      limit?: number,
      signal?: AbortSignal,
      options?: { compact?: boolean; allowRemoteDeliveryChecks?: boolean; targets?: TerminalWorkspaceTargets },
    ): Promise<{ checked: number }>;
    nextTerminalWorkspaceSweepAt(): Promise<number | null>;
    hasTerminalWorkspaceSweepContinuation(): boolean;
    terminalWorkspaceWorkSettled?(hints?: ReadonlySet<string>, options?: { targeted?: boolean }): void;
  },
  canRun: () => boolean,
) {
  let next: number | null = Date.now();
  let recovered = false;
  // The first sweep runs while the server finishes starting (it does not hold
  // readiness). Compaction walks worktrees and deletes dependency trees, which
  // can take seconds per workspace, so the first sweep skips it and later
  // sweeps do it.
  let startupSweepStarted = false;
  let rotationRequested = false;
  let dueAt: number | null = null;
  let lastRotationPageAt = 0;
  const targetWorkspaceIds = new Set<string>(), targetIssueIds = new Set<string>();
  const worker = coordinator.register(DELIVERY_QUEUES.terminalWorkspaces, {
    retryMs: TERMINAL_WORKSPACE_RETRY_MS,
    onSettled: hints => {
      const targets = terminalWorkspaceTargetsFromHints(hints);
      for (const id of targets?.workspaceIds ?? []) targetWorkspaceIds.add(id);
      for (const id of targets?.issueIds ?? []) targetIssueIds.add(id);
      const overflow = targetWorkspaceIds.size + targetIssueIds.size > MAX_TERMINAL_WORKSPACE_TARGETS;
      service.terminalWorkspaceWorkSettled?.(hints, { targeted: Boolean(targets) && !overflow });
      if (!targets || overflow) {
        rotationRequested = true;
        targetWorkspaceIds.clear(); targetIssueIds.clear();
      }
    },
    run: async signal => {
      recovered = false;
      const due = dueAt !== null && dueAt <= Date.now();
      dueAt = null;
      next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      const startup = !startupSweepStarted;
      startupSweepStarted = true;
      const options = { compact: !startup, allowRemoteDeliveryChecks: !startup };
      const targeted = targetWorkspaceIds.size + targetIssueIds.size > 0;
      if (startup || due || rotationRequested || !targeted
        || (service.hasTerminalWorkspaceSweepContinuation() && Date.now() >= lastRotationPageAt + 1000)) {
        rotationRequested = false;
        lastRotationPageAt = Date.now();
        return service.sweepTerminalWorkspaces(50, signal, options);
      }
      const targets = { workspaceIds: [...targetWorkspaceIds], issueIds: [...targetIssueIds] };
      targetWorkspaceIds.clear(); targetIssueIds.clear();
      try {
        return await service.sweepTerminalWorkspaces(50, signal, { ...options, targets });
      } catch (error) {
        rotationRequested = true;
        throw error;
      }
    },
    hasPending: async () => {
      if (!canRun()) next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      else if (service.hasTerminalWorkspaceSweepContinuation()) next = Math.max(Date.now(), lastRotationPageAt + 1000);
      else if (rotationRequested || targetWorkspaceIds.size + targetIssueIds.size > 0) next = Date.now();
      else {
        const deadline = await service.nextTerminalWorkspaceSweepAt();
        next = deadline === null ? null : deadline > Date.now()
          ? deadline : Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
        dueAt = next;
        recovered = true;
      }
      return false;
    },
    nextRunAt: () => next,
  });
  return { ...worker, hasUnrecoveredWork: () => !recovered };
}
