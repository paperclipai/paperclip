import type { Agent } from "@paperclipai/shared";

const ACTIVE_ROSTER_STATES = new Set([
  "active",
  "running",
  "idle",
  "idle_queued",
  "blocked",
]);

export function isPullAgent(agent: Pick<Agent, "runtimeConfig">): boolean {
  return agent.runtimeConfig?.executionModel === "pull";
}

/** Pull seats stay off the adapter timer unless dispatch is explicitly enabled. */
export function pullAgentHeartbeatDispatchEnabled(agent: Pick<Agent, "runtimeConfig">): boolean {
  return isPullAgent(agent) && agent.runtimeConfig.pull?.dispatchEnabled === true;
}

/** Config/save UI must not turn the timer on for a pull seat. */
export function pullAgentHeartbeatLocked(agent: Pick<Agent, "runtimeConfig">): boolean {
  return isPullAgent(agent) && !pullAgentHeartbeatDispatchEnabled(agent);
}

/**
 * Roster/detail chips prefer the derived pull lease over agents.status.
 * An expired lease can leave status=running while pullLifecycle.state is unreachable.
 */
export function agentRosterStatus(
  agent: Pick<Agent, "status" | "runtimeConfig" | "pullLifecycle">,
): string {
  if (isPullAgent(agent) && agent.pullLifecycle?.state) {
    return agent.pullLifecycle.state;
  }
  return agent.status;
}

export function rosterMatchesActiveFilter(status: string): boolean {
  return ACTIVE_ROSTER_STATES.has(status);
}
