import type { AgentLifecycleState } from "@paperclipai/shared";

export type LifecycleCommand = "reconcile" | "approve" | "reject" | "pause" | "resume" | "terminate" | "complete" | "retry";
export class AgentLifecycleConflict extends Error {
  constructor(message: string) { super(message); this.name = "AgentLifecycleConflict"; }
}

export function canConfigureAgentConnection(agent: { lifecycleState: string; status: string }): boolean {
  return agent.lifecycleState === "preparing" || agent.lifecycleState === "verifying"
    || (agent.lifecycleState === "ready" && !["paused", "terminated", "pending_approval"].includes(agent.status));
}

export function isAgentAwaitingSetup(agent: { lifecycleState: string; lifecycleHolds: readonly string[] }): boolean {
  return ["preparing", "verifying", "resuming"].includes(agent.lifecycleState) && agent.lifecycleHolds.length === 0;
}

export function transition(state: AgentLifecycleState, command: LifecycleCommand,
  resumeState: "preparing" | "verifying" | "ready" = "ready"): AgentLifecycleState {
  if (command === "retry") {
    if (["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"].includes(state)) return state;
  } else if (command === "terminate") {
    if (["terminated", "rejected", "terminating", "cleaning_up"].includes(state)) return state;
    return "terminating";
  } else if (command === "approve") {
    if (state === "pending_approval") return "preparing";
  } else if (command === "reject") {
    if (state === "pending_approval") return "rejected";
    if (state === "rejected") return state;
  } else if (command === "pause") {
    if (state === "paused" || state === "pausing") return state;
    if (["ready", "preparing", "verifying", "resuming"].includes(state)) return "pausing";
  } else if (command === "resume") {
    if (state === "ready" || state === "resuming") return state;
    if (state === "paused") return "resuming";
  } else if (command === "complete") {
    switch (state) {
      case "preparing": return "verifying";
      case "verifying": return "ready";
      case "pausing": return "paused";
      case "resuming": return resumeState;
      case "terminating": return "cleaning_up";
      case "cleaning_up": return "terminated";
    }
  }
  throw new AgentLifecycleConflict(`Cannot ${command} an agent in state ${state}`);
}

export function compatibilityStatus(state: AgentLifecycleState, executionStatus = "idle"): string {
  if (state === "ready") return ["active", "idle", "running", "error"].includes(executionStatus) ? executionStatus : "idle";
  if (state === "pending_approval") return "pending_approval";
  if (["terminating", "cleaning_up", "terminated", "rejected"].includes(state)) return "terminated";
  return "paused";
}

export function isLifecycleWorkPending(state: AgentLifecycleState): boolean {
  return ["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"].includes(state);
}
