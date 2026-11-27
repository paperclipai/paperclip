import type { SlotFree } from "./universal.js";

export const AGENT_SLOTS_FILE = "agent-slots.json";

export interface AgentSlots {
  agents: Array<{ agentId: string; maxConcurrentRuns: number | null }>;
  runs: Array<{ runId: string; agentId: string; createdAt?: number | null; invocationSource?: string | null; retryOfRunId?: string | null;
    startedAt: number | null; finishedAt: number | null }>;
}

export const QUEUE_HANDOFF_TOLERANCE_MS = 2_000;

export type QueueFairness = { verdict: "fair" } | { verdict: "unfair" | "unproven"; reason: string };
export type QueueWaitFairness = (runId: string, createdAt: number, startedAt: number, outages?: ReadonlyArray<readonly [number, number]>) => QueueFairness;

const iso = (at: number) => new Date(at).toISOString();

export function queueWaitFairnessFrom(slots: AgentSlots | null): QueueWaitFairness {
  const caps = new Map((slots?.agents ?? []).map(agent => [agent.agentId, agent.maxConcurrentRuns]));
  const agentOf = new Map((slots?.runs ?? []).map(run => [run.runId, run.agentId]));
  return (runId, createdAt, startedAt, outages = []) => {
    const agentId = agentOf.get(runId);
    const cap = agentId ? caps.get(agentId) : undefined;
    if (!slots || !agentId || typeof cap !== "number" || cap < 1) return { verdict: "unproven", reason: `no agent slot evidence for ${runId}` };
    const others = slots.runs.filter(run => run.agentId === agentId && run.runId !== runId);
    const malformed = others.filter(run => [run.startedAt, run.finishedAt].some(at => at !== null && !Number.isFinite(at)));
    if (malformed.length) return { verdict: "unproven", reason: `malformed start or finish time for ${malformed.map(run => run.runId).join(",")}` };
    const startedAhead = others.filter(run => Number.isFinite(run.startedAt) && run.startedAt! >= createdAt && run.startedAt! < startedAt);
    const newer = startedAhead.filter(run => Number.isFinite(run.createdAt) && run.createdAt! > createdAt);
    const overtaker = newer.find(run => run.invocationSource === "assignment" && !run.retryOfRunId);
    if (overtaker) {
      return { verdict: "unfair", reason: `assignment run ${overtaker.runId} created ${iso(overtaker.createdAt!)} started ${iso(overtaker.startedAt!)} ahead of ${runId}` };
    }
    const running = (at: number) => others.filter(run => run.startedAt !== null && run.startedAt <= at
      && (run.finishedAt === null || run.finishedAt > at)).length;
    const points = [...new Set([createdAt, startedAt, ...others.flatMap(run => [run.startedAt, run.finishedAt])
      .filter((at): at is number => at !== null && at > createdAt && at < startedAt)])].sort((a, b) => a - b);
    const idleGaps: Array<[number, number]> = [];
    let idleFrom: number | null = null;
    for (const at of points) {
      if (at < startedAt && running(at) < cap) { idleFrom ??= at; continue; }
      if (idleFrom !== null && at - idleFrom > QUEUE_HANDOFF_TOLERANCE_MS) idleGaps.push([idleFrom, at]);
      idleFrom = null;
    }
    const duringOutage = ([from, to]: readonly [number, number]) => outages.some(([start, end]) => start < to && end > from);
    const idle = idleGaps.find(gap => !duringOutage(gap));
    if (idle) return { verdict: "unfair", reason: `agent ${agentId} had an idle slot from ${iso(idle[0])} to ${iso(idle[1])} while ${runId} was queued` };
    if (idleGaps.length) {
      return { verdict: "unproven", reason: `idle slot from ${iso(idleGaps[0]![0])} to ${iso(idleGaps[0]![1])} overlapped a server outage while ${runId} was queued` };
    }
    const unknown = startedAhead.filter(run => !Number.isFinite(run.createdAt));
    if (unknown.length) return { verdict: "unproven", reason: `no createdAt for ${unknown.map(run => run.runId).join(",")}, which started while ${runId} was queued` };
    const unclassified = newer.filter(run => run.invocationSource == null);
    if (unclassified.length) return { verdict: "unproven", reason: `no invocation source for newer run ${unclassified.map(run => run.runId).join(",")}, which started while ${runId} was queued` };
    return { verdict: "fair" };
  };
}

export function slotFreeFrom(slots: AgentSlots | null): SlotFree {
  if (!slots) return () => null;
  const caps = new Map(slots.agents.map(agent => [agent.agentId, agent.maxConcurrentRuns]));
  const agentOf = new Map(slots.runs.map(run => [run.runId, run.agentId]));
  const byAgent = new Map<string, AgentSlots["runs"]>();
  for (const run of slots.runs) byAgent.set(run.agentId, [...byAgent.get(run.agentId) ?? [], run]);
  return (runId, at) => {
    const agentId = agentOf.get(runId);
    const cap = agentId ? caps.get(agentId) : undefined;
    if (!agentId || typeof cap !== "number" || cap < 1) return null;
    const running = (byAgent.get(agentId) ?? []).filter(run => run.runId !== runId && run.startedAt !== null && run.startedAt <= at
      && (run.finishedAt === null || run.finishedAt > at)).length;
    return running < cap;
  };
}

export function agentSlotsFromRows(agents: ReadonlyArray<Record<string, unknown>>, runs: ReadonlyArray<Record<string, unknown>>): AgentSlots {
  const ms = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    agents: agents.map(agent => {
      const cap = Number(agent.maxConcurrentRuns);
      return { agentId: String(agent.id), maxConcurrentRuns: Number.isInteger(cap) && cap > 0 ? cap : null };
    }),
    runs: runs.filter(run => run.agentId).map(run => ({ runId: String(run.id), agentId: String(run.agentId), createdAt: ms(run.createdAt),
      invocationSource: run.invocationSource == null ? null : String(run.invocationSource), retryOfRunId: run.retryOfRunId == null ? null : String(run.retryOfRunId),
      startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt) })),
  };
}
