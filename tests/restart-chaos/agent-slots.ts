import type { SlotFree } from "./universal.js";

export const AGENT_SLOTS_FILE = "agent-slots.json";

export interface AgentSlots {
  agents: Array<{ agentId: string; maxConcurrentRuns: number | null }>;
  runs: Array<{ runId: string; agentId: string; startedAt: number | null; finishedAt: number | null }>;
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
    runs: runs.filter(run => run.agentId).map(run => ({ runId: String(run.id), agentId: String(run.agentId), startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt) })),
  };
}
