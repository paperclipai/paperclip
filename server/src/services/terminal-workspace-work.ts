import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const TERMINAL_WORKSPACE_RETRY_MS = 5 * 60 * 1000;
export const MAX_TERMINAL_WORKSPACE_TARGETS = 50;
export const TERMINAL_WORKSPACE_BACKSTOP_MS = 60 * 60 * 1000;
export const TERMINAL_WORKSPACE_PLUGIN_HINT = "plugin-workspaces";

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
    takeDueTerminalWorkspaceTargets?(): { workspaceIds: string[]; rotation: boolean };
    listPluginTerminalWorkspaceIds?(): Promise<string[]>;
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
  let dueAt: number | null = null;
  let lastRotationPageAt = 0;
  let backstopArmed = false;
  let lastFullRotationAt = Date.now();
  let continuing = false;
  let pluginRefresh = false;
  const pendingWorkspaceIds = new Set<string>(), pendingIssueIds = new Set<string>();
  const pendingCount = () => pendingWorkspaceIds.size + pendingIssueIds.size;
  const takeTargets = (): TerminalWorkspaceTargets => {
    const workspaceIds = [...pendingWorkspaceIds].slice(0, MAX_TERMINAL_WORKSPACE_TARGETS);
    for (const id of workspaceIds) pendingWorkspaceIds.delete(id);
    const issueIds = [...pendingIssueIds].slice(0, MAX_TERMINAL_WORKSPACE_TARGETS - workspaceIds.length);
    for (const id of issueIds) pendingIssueIds.delete(id);
    return { workspaceIds, issueIds };
  };
  const worker = coordinator.register(DELIVERY_QUEUES.terminalWorkspaces, {
    retryMs: TERMINAL_WORKSPACE_RETRY_MS,
    onSettled: hints => {
      backstopArmed = true;
      if (hints?.has(TERMINAL_WORKSPACE_PLUGIN_HINT)) pluginRefresh = true;
      const scoped = hints ? new Set([...hints].filter(hint => hint !== TERMINAL_WORKSPACE_PLUGIN_HINT)) : undefined;
      const targets = terminalWorkspaceTargetsFromHints(scoped);
      for (const id of targets?.workspaceIds ?? []) pendingWorkspaceIds.add(id);
      for (const id of targets?.issueIds ?? []) pendingIssueIds.add(id);
      service.terminalWorkspaceWorkSettled?.(hints, { targeted: true });
    },
    run: async signal => {
      recovered = false;
      const due = dueAt !== null && dueAt <= Date.now();
      dueAt = null;
      next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      const startup = !startupSweepStarted;
      startupSweepStarted = true;
      const options = { compact: !startup, allowRemoteDeliveryChecks: !startup };
      let prelude = false;
      const legacyDue = due && !startup && !service.takeDueTerminalWorkspaceTargets;
      if (due && !startup && service.takeDueTerminalWorkspaceTargets) {
        const dueTargets = service.takeDueTerminalWorkspaceTargets();
        for (const id of dueTargets.workspaceIds) pendingWorkspaceIds.add(id);
        if (dueTargets.rotation) { prelude = true; backstopArmed = true; }
      }
      if (pluginRefresh && !startup && service.listPluginTerminalWorkspaceIds) {
        pluginRefresh = false;
        try {
          for (const id of await service.listPluginTerminalWorkspaceIds()) pendingWorkspaceIds.add(id);
        } catch (error) {
          pluginRefresh = true;
          throw error;
        }
      }
      const backstopDue = backstopArmed && Date.now() >= lastFullRotationAt + TERMINAL_WORKSPACE_BACKSTOP_MS;
      if (startup || backstopDue || legacyDue || (continuing && Date.now() >= lastRotationPageAt + 1000)) {
        lastRotationPageAt = Date.now();
        if (!continuing) { lastFullRotationAt = Date.now(); backstopArmed = false; pluginRefresh = false; }
        return service.sweepTerminalWorkspaces(50, signal, options);
      }
      if (pendingCount() === 0 && !prelude) return { checked: 0 };
      const targets = takeTargets();
      try {
        return await service.sweepTerminalWorkspaces(50, signal, { ...options, targets });
      } catch (error) {
        for (const id of targets.workspaceIds) pendingWorkspaceIds.add(id);
        for (const id of targets.issueIds) pendingIssueIds.add(id);
        throw error;
      }
    },
    hasPending: async () => {
      if (canRun()) continuing = service.hasTerminalWorkspaceSweepContinuation();
      if (!canRun()) next = Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
      else if (continuing) next = Math.max(Date.now(), lastRotationPageAt + 1000);
      else if (pendingCount() > 0 || pluginRefresh) next = Date.now();
      else {
        const deadline = await service.nextTerminalWorkspaceSweepAt();
        next = deadline === null ? null : deadline > Date.now()
          ? deadline : Date.now() + TERMINAL_WORKSPACE_RETRY_MS;
        dueAt = next;
        recovered = true;
      }
      if (backstopArmed && canRun()) {
        const backstopAt = lastFullRotationAt + TERMINAL_WORKSPACE_BACKSTOP_MS;
        next = next === null ? backstopAt : Math.min(next, backstopAt);
      }
      return false;
    },
    nextRunAt: () => next,
  });
  return { ...worker, hasUnrecoveredWork: () => !recovered };
}
