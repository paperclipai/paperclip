import { useCallback, useMemo, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";

type UseAgentOrderParams = {
  agents: Agent[];
  companyId: string | null | undefined;
};

function areEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sortAgentsByOrder(agents: Agent[], orderedIds: string[]): Agent[] {
  if (agents.length === 0) return [];
  if (orderedIds.length === 0) return agents;

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const sorted: Agent[] = [];

  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }
  for (const agent of byId.values()) {
    sorted.push(agent);
  }
  return sorted;
}

function buildInitialOrder(agents: Agent[]): string[] {
  const withOrder = agents.filter((a) => a.sortOrder != null).sort((a, b) => a.sortOrder! - b.sortOrder!);
  const without = agents.filter((a) => a.sortOrder == null);
  return [...withOrder, ...without].map((a) => a.id);
}

export function useAgentOrder({ agents, companyId }: UseAgentOrderParams) {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => buildInitialOrder(agents));

  const stableIds = useMemo(() => {
    return buildInitialOrder(agents);
  }, [agents]);

  const effectiveIds = useMemo(() => {
    const agentIdSet = new Set(agents.map((a: Agent) => a.id));
    const merged = orderedIds.filter((id) => agentIdSet.has(id));
    for (const a of agents) {
      if (!merged.includes(a.id)) merged.push(a.id);
    }
    if (areEqual(merged, orderedIds)) return orderedIds;
    return merged;
  }, [agents, orderedIds]);

  const orderedAgents = useMemo(
    () => sortAgentsByOrder(agents, effectiveIds),
    [agents, effectiveIds],
  );

  const persistOrder = useCallback(
    (ids: string[]) => {
      const agentIdSet = new Set(agents.map((a: Agent) => a.id));
      const filtered = ids.filter((id) => agentIdSet.has(id));
      for (const a of agents) {
        if (!filtered.includes(a.id)) filtered.push(a.id);
      }

      setOrderedIds((current) => (areEqual(current, filtered) ? current : filtered));

      if (companyId) {
        agentsApi.reorder(companyId, filtered).catch(() => {
          setOrderedIds(stableIds);
        });
      }
    },
    [agents, companyId, stableIds],
  );

  return {
    orderedAgents,
    orderedIds: effectiveIds,
    persistOrder,
  };
}
