import {
  AGENT_SCHEDULER_DEQUEUE_REASON,
  AGENT_SCHEDULER_ENQUEUE_REASON,
  decideAgentRunMaterialization,
  resolveEffectiveAgentCapacity,
  type AgentSchedulerCapacityFacts,
} from "../domain/policy.js";
import type { AgentSchedulerHost, AgentSchedulerWriter, RunnableWakeRow } from "./ports.js";

export type AgentSchedulerAdmissionInput = AgentSchedulerCapacityFacts & {
  companyId: string;
  agentId: string;
  wakeRequestId: string;
  issueId: string | null;
};

export function createEvaluateAgentSchedulerAdmission(deps: {
  host: AgentSchedulerHost;
  writer: AgentSchedulerWriter;
}) {
  return async function evaluateAgentSchedulerAdmission(
    input: AgentSchedulerAdmissionInput,
  ): Promise<{ action: "materialize" } | { action: "park"; queueDepth: number }> {
    const decision = decideAgentRunMaterialization(input);
    if (decision.kind === "materialize") {
      return { action: "materialize" };
    }

    const runnable = await deps.writer.listRunnableWakes(input.agentId, 500);
    const queueDepth = runnable.length + 1;
    await deps.writer.parkWakeAsRunnable({
      wakeRequestId: input.wakeRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      enqueueReason: AGENT_SCHEDULER_ENQUEUE_REASON,
      schedulerMeta: {
        parkedAt: new Date().toISOString(),
        triggerReason: decision.reason,
        effectiveCapacity: decision.effectiveCapacity,
        runningRunCount: input.runningRunCount,
        queueDepth,
      },
    });
    await deps.host.appendSchedulerEvent({
      companyId: input.companyId,
      agentId: input.agentId,
      wakeRequestId: input.wakeRequestId,
      issueId: input.issueId,
      kind: "enqueue",
      reason: decision.reason,
      queueDepth,
      effectiveCapacity: decision.effectiveCapacity,
    });
    return { action: "park", queueDepth };
  };
}

export type MaterializeRunnableWakeInput = {
  schedulerEnabled: boolean;
  allowParallelExecution: boolean;
  configuredMaxConcurrentRuns: number;
  agentId: string;
  companyId: string;
  createRunForWake: (wake: RunnableWakeRow) => Promise<string | null>;
};

export function createPromoteAgentRunnableWork(deps: {
  host: AgentSchedulerHost;
  writer: AgentSchedulerWriter;
}) {
  return async function promoteAgentRunnableWork(
    input: MaterializeRunnableWakeInput,
  ): Promise<{ promoted: number; runIds: string[] }> {
    if (!input.schedulerEnabled) {
      return { promoted: 0, runIds: [] };
    }

    const runningRunCount = await deps.host.countRunningRunsForAgent(input.agentId);
    const effectiveCapacity = resolveEffectiveAgentCapacity({
      schedulerEnabled: input.schedulerEnabled,
      allowParallelExecution: input.allowParallelExecution,
      configuredMaxConcurrentRuns: input.configuredMaxConcurrentRuns,
      runningRunCount,
    });
    const availableSlots = Math.max(0, effectiveCapacity - runningRunCount);
    if (availableSlots <= 0) {
      return { promoted: 0, runIds: [] };
    }

    const pending = await deps.writer.listRunnableWakes(input.agentId, availableSlots);
    const runIds: string[] = [];
    let promoted = 0;

    for (const wake of pending) {
      const runId = await input.createRunForWake(wake);
      if (!runId) continue;
      const linked = await deps.writer.materializeRunnableWake({
        wake,
        runId,
        dequeueReason: AGENT_SCHEDULER_DEQUEUE_REASON,
      });
      if (!linked) continue;
      promoted += 1;
      runIds.push(runId);
      const queueDepth = Math.max(0, pending.length - promoted);
      await deps.host.appendSchedulerEvent({
        companyId: input.companyId,
        agentId: input.agentId,
        wakeRequestId: wake.id,
        issueId: readIssueId(wake.payload),
        kind: "dequeue",
        reason: AGENT_SCHEDULER_DEQUEUE_REASON,
        queueDepth,
        effectiveCapacity,
      });
    }

    return { promoted, runIds };
  };
}

function readIssueId(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const issueId = payload.issueId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

export function readAgentParallelExecutionAllowed(runtimeConfig: unknown): boolean {
  const root = runtimeConfig && typeof runtimeConfig === "object"
    ? runtimeConfig as Record<string, unknown>
    : {};
  const heartbeat = root.heartbeat && typeof root.heartbeat === "object"
    ? root.heartbeat as Record<string, unknown>
    : {};
  return heartbeat.allowParallelExecution === true;
}
