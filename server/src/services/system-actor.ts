import type { LogActivityInput } from "./activity-log.js";

export type SystemActorInfo = {
  actorType: "system";
  actorId: string;
  agentId: null;
  runId: null;
};

/**
 * Returns an actor info object for operations originating from internal
 * subsystems rather than a user or agent request. The subsystem label
 * (e.g. "heartbeat", "budget", "routine") appears as actorId in the
 * audit log so operators can trace which subsystem performed the action.
 *
 * Compatible with the shape returned by getActorInfo() so service
 * functions can accept either without branching.
 */
export function withSystemActor(subsystem: string): SystemActorInfo {
  return {
    actorType: "system",
    actorId: `system.${subsystem}`,
    agentId: null,
    runId: null,
  };
}

/** Convenience: build a LogActivityInput actor fragment for system-originated actions. */
export function systemActorFragment(subsystem: string): Pick<LogActivityInput, "actorType" | "actorId"> {
  return {
    actorType: "system",
    actorId: `system.${subsystem}`,
  };
}
