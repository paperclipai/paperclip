export type AgentSchedulerCapacityFacts = {
  schedulerEnabled: boolean;
  allowParallelExecution: boolean;
  configuredMaxConcurrentRuns: number;
  runningRunCount: number;
};

export type AgentSchedulerCapacityDecision =
  | { kind: "materialize" }
  | { kind: "park_runnable"; effectiveCapacity: number; reason: "agent_at_capacity" };

const DEFAULT_SERIAL_CAPACITY = 1;

export function resolveEffectiveAgentCapacity(facts: AgentSchedulerCapacityFacts): number {
  if (!facts.schedulerEnabled) {
    return facts.configuredMaxConcurrentRuns;
  }
  if (facts.allowParallelExecution) {
    return Math.max(1, facts.configuredMaxConcurrentRuns);
  }
  return DEFAULT_SERIAL_CAPACITY;
}

/**
 * Decides whether a new wake should create a heartbeat run now or park as
 * agent-runnable work behind the per-agent scheduler.
 */
export function decideAgentRunMaterialization(
  facts: AgentSchedulerCapacityFacts,
): AgentSchedulerCapacityDecision {
  const effectiveCapacity = resolveEffectiveAgentCapacity(facts);
  if (facts.runningRunCount >= effectiveCapacity) {
    return {
      kind: "park_runnable",
      effectiveCapacity,
      reason: "agent_at_capacity",
    };
  }
  return { kind: "materialize" };
}

export const AGENT_SCHEDULER_ENQUEUE_REASON = "agent_scheduler_enqueued";
export const AGENT_SCHEDULER_DEQUEUE_REASON = "agent_scheduler_promoted";
