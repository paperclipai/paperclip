import type { SlotFree } from "./universal.js";

export const AGENT_SLOTS_FILE = "agent-slots.json";

export interface AgentSlots {
  agents: Array<{ agentId: string; maxConcurrentRuns: number | null }>;
  runs: Array<{ runId: string; agentId: string; createdAt?: number | null; startedAt: number | null; finishedAt: number | null }>;
}

export const QUEUE_HANDOFF_TOLERANCE_MS = 2_000;

export type QueueFairness = { verdict: "fair" } | { verdict: "unfair" | "unproven"; reason: string };
export type QueueWaitFairness = (runId: string, createdAt: number, startedAt: number) => QueueFairness;

export function queueWaitFairnessFrom(slots: AgentSlots | null): QueueWaitFairness {
  const caps = new Map((slots?.agents ?? []).map(agent => [agent.agentId, agent.maxConcurrentRuns]));
  const agentOf = new Map((slots?.runs ?? []).map(run => [run.runId, run.agentId]));
  return (runId, createdAt, startedAt) => {
    const agentId = agentOf.get(runId);
    const cap = agentId ? caps.get(agentId) : undefined;
    if (!slots || !agentId || typeof cap !== "number" || cap < 1) return { verdict: "unproven", reason: `no agent slot evidence for ${runId}` };
    const others = slots.runs.filter(run => run.agentId === agentId && run.runId !== runId);
    const startedAhead = others.filter(run => run.startedAt !== null && run.startedAt >= createdAt && run.startedAt < startedAt);
    const overtaker = startedAhead.find(run => typeof run.createdAt === "number" && run.createdAt > createdAt);
    if (overtaker) {
      return { verdict: "unfair", reason: `run ${overtaker.runId} created ${new Date(overtaker.createdAt!).toISOString()} started ${new Date(overtaker.startedAt!).toISOString()} ahead of ${runId}` };
    }
    const running = (at: number) => others.filter(run => run.startedAt !== null && run.startedAt <= at
      && (run.finishedAt === null || run.finishedAt > at)).length;
    const points = [...new Set([createdAt, startedAt, ...others.flatMap(run => [run.startedAt, run.finishedAt])
      .filter((at): at is number => at !== null && at > createdAt && at < startedAt)])].sort((a, b) => a - b);
    let idleFrom: number | null = null;
    for (const at of points) {
      const idle = at < startedAt && running(at) < cap;
      if (idle) { idleFrom ??= at; continue; }
      if (idleFrom !== null && at - idleFrom > QUEUE_HANDOFF_TOLERANCE_MS) {
        return { verdict: "unfair", reason: `agent ${agentId} had an idle slot from ${new Date(idleFrom).toISOString()} to ${new Date(at).toISOString()} while ${runId} was queued` };
      }
      idleFrom = null;
    }
    const unknown = startedAhead.filter(run => typeof run.createdAt !== "number");
    if (unknown.length) return { verdict: "unproven", reason: `no createdAt for ${unknown.map(run => run.runId).join(",")}, which started while ${runId} was queued` };
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
      startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt) })),
  };
}
