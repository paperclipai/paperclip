import type { TelemetryDimensions, TelemetryEventName } from "../types.js";

/** Minimal interface for the browser telemetry tracker. */
export interface BrowserTelemetryTracker {
  track(eventName: TelemetryEventName, dimensions?: TelemetryDimensions): void;
  /** SubtleCrypto-backed hash — async in browser. */
  hashPrivateRef(value: string): Promise<string>;
}

let browserTracker: BrowserTelemetryTracker | null = null;

export function setBrowserTelemetryTracker(tracker: BrowserTelemetryTracker | null): void {
  browserTracker = tracker;
}

export function getBrowserTelemetryTracker(): BrowserTelemetryTracker | null {
  return browserTracker;
}

export function trackInstallStarted(): void {
  browserTracker?.track("install.started");
}

export function trackInstallCompleted(dims: { adapterType: string }): void {
  browserTracker?.track("install.completed", { adapter_type: dims.adapterType });
}

export async function trackCompanyImported(dims: {
  sourceType: string;
  sourceRef: string;
  isPrivate: boolean;
}): Promise<void> {
  if (!browserTracker) return;
  const ref = dims.isPrivate ? await browserTracker.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  browserTracker.track("company.imported", {
    source_type: dims.sourceType,
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackProjectCreated(): void {
  browserTracker?.track("project.created");
}

export function trackRoutineCreated(): void {
  browserTracker?.track("routine.created");
}

export function trackRoutineRun(dims: { source: string; status: string }): void {
  browserTracker?.track("routine.run", { source: dims.source, status: dims.status });
}

export function trackTaskCreated(dims: {
  workMode: string;
  priority: string;
  hasAssignee: boolean;
}): void {
  browserTracker?.track("task.created", {
    work_mode: dims.workMode,
    priority: dims.priority,
    has_assignee: dims.hasAssignee,
  });
}

export function trackTaskStatusChanged(dims: { from: string; to: string; workMode: string }): void {
  browserTracker?.track("task.status_changed", {
    from: dims.from,
    to: dims.to,
    work_mode: dims.workMode,
  });
}

export function trackTaskCompleted(dims: { outcome: "done" | "cancelled"; workMode: string }): void {
  browserTracker?.track("task.completed", { outcome: dims.outcome, work_mode: dims.workMode });
}

export function trackTaskBlocked(dims: { hasBlockerCount: number }): void {
  browserTracker?.track("task.blocked", { has_blocker_count: dims.hasBlockerCount });
}

export function trackTaskReopened(dims: { from: "done" | "cancelled"; workMode: string }): void {
  browserTracker?.track("task.reopened", { from: dims.from, work_mode: dims.workMode });
}

export function trackProductFirstTaskCompleted(): void {
  browserTracker?.track("product.first_task_completed");
}

export function trackGoalCreated(dims?: { goalLevel?: string | null }): void {
  browserTracker?.track("goal.created", dims?.goalLevel ? { goal_level: dims.goalLevel } : undefined);
}

export function trackAgentCreated(dims: { agentRole: string; agentId?: string }): void {
  browserTracker?.track("agent.created", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackSkillImported(dims: { sourceType: string; skillRef?: string | null }): void {
  browserTracker?.track("skill.imported", {
    source_type: dims.sourceType,
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackSkillInvoked(dims: { sourceType: string; skillRef?: string | null }): void {
  browserTracker?.track("skill.invoked", {
    source_type: dims.sourceType,
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackInteractionCreated(dims: { kind: string; continuationPolicy: string }): void {
  browserTracker?.track("interaction.created", {
    kind: dims.kind,
    continuation_policy: dims.continuationPolicy,
  });
}

export function trackInteractionResolved(dims: {
  kind: string;
  outcome: "accepted" | "rejected" | "expired" | "superseded" | "cancelled";
}): void {
  browserTracker?.track("interaction.resolved", { kind: dims.kind, outcome: dims.outcome });
}

export function trackAgentFirstHeartbeat(dims: { agentRole: string; agentId?: string }): void {
  browserTracker?.track("agent.first_heartbeat", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackAgentTaskCompleted(dims: {
  agentRole: string;
  agentId?: string;
  adapterType?: string;
  model?: string;
}): void {
  browserTracker?.track("agent.task_completed", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
    ...(dims.adapterType ? { adapter_type: dims.adapterType } : {}),
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackErrorHandlerCrash(dims: { errorCode: string }): void {
  browserTracker?.track("error.handler_crash", { error_code: dims.errorCode });
}
