import type { ExecutionAgentQueue, ExecutionProjection } from "@paperclipai/shared";
import { agentDetailHref } from "../pages/agent-detail-navigation";
import { agentRouteRef } from "./utils";

/** The server's explanation that a run waits for a free slot of its agent. */
export function agentQueueWaitOf(
  execution: Pick<ExecutionProjection, "cause" | "agentQueue"> | null | undefined,
): ExecutionAgentQueue | null {
  return execution?.cause === "agent_at_capacity" && execution.agentQueue ? execution.agentQueue : null;
}

/** A run the server accepted but never started: it waits, it is not working. */
export function isWaitingToStart(run: { status: string; startedAt?: string | Date | null }): boolean {
  return run.status === "queued" && !run.startedAt;
}

/** "Waiting for Codie", "20 slots max", "41 of 295 in line". */
export function agentQueueWaitParts(queue: ExecutionAgentQueue): [string, string, string] {
  return [
    `Waiting for ${queue.agentName}`,
    `${queue.maxConcurrentRuns} ${queue.maxConcurrentRuns === 1 ? "slot" : "slots"} max`,
    `${queue.position} of ${queue.queuedCount} in line`,
  ];
}

/** Where the agent's concurrency limit is edited (its run policy, in the Advanced view). */
export function agentQueueConfigureHref(queue: Pick<ExecutionAgentQueue, "agentId" | "agentName">): string {
  return agentDetailHref(agentRouteRef({ id: queue.agentId, name: queue.agentName }), "advanced");
}
