import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import {
  AGENT_ORDER_UPDATED_EVENT,
  getAgentOrderStorageKey,
  readAgentOrder,
  sortAgentsByStoredOrder,
  writeAgentOrder,
  type AgentSidebarOrderOptions,
} from "../lib/agent-order";

type UseAgentOrderParams = {
  agents: Agent[];
  companyId: string | null | undefined;
  userId: string | null | undefined;
};

type AgentOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function areEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildOrderIds(agents: Agent[], orderedIds: string[], options: AgentSidebarOrderOptions) {
  return sortAgentsByStoredOrder(agents, orderedIds, options).map((agent) => agent.id);
}

export function useAgentOrder({ agents, companyId, userId }: UseAgentOrderParams) {
  const sortOptions = useMemo<AgentSidebarOrderOptions>(
    () => ({ leadershipFirst: true }),
    [],
  );
  const storageKey = useMemo(() => {
    if (!companyId) return null;
    return getAgentOrderStorageKey(companyId, userId);
  }, [companyId, userId]);

  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    if (!storageKey) return agents.map((agent) => agent.id);
    return buildOrderIds(agents, readAgentOrder(storageKey), sortOptions);
  });

  useEffect(() => {
    const nextIds = storageKey
      ? buildOrderIds(agents, readAgentOrder(storageKey), sortOptions)
      : agents.map((agent) => agent.id);
    setOrderedIds((current) => (areEqual(current, nextIds) ? current : nextIds));
  }, [agents, storageKey, sortOptions]);

  useEffect(() => {
    if (!storageKey) return;

    const syncFromIds = (ids: string[]) => {
      const nextIds = buildOrderIds(agents, ids, sortOptions);
      setOrderedIds((current) => (areEqual(current, nextIds) ? current : nextIds));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      syncFromIds(readAgentOrder(storageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<AgentOrderUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      syncFromIds(detail.orderedIds);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(AGENT_ORDER_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AGENT_ORDER_UPDATED_EVENT, onCustomEvent);
    };
  }, [agents, storageKey, sortOptions]);

  const orderedAgents = useMemo(
    () => sortAgentsByStoredOrder(agents, orderedIds, sortOptions),
    [agents, orderedIds, sortOptions],
  );

  const persistOrder = useCallback(
    (ids: string[]) => {
      const idSet = new Set(agents.map((agent) => agent.id));
      const filtered = ids.filter((id) => idSet.has(id));
      for (const agent of sortAgentsByStoredOrder(agents, [], sortOptions)) {
        if (!filtered.includes(agent.id)) filtered.push(agent.id);
      }

      setOrderedIds((current) => (areEqual(current, filtered) ? current : filtered));
      if (storageKey) {
        writeAgentOrder(storageKey, filtered);
      }
    },
    [agents, storageKey, sortOptions],
  );

  return {
    orderedAgents,
    orderedIds,
    persistOrder,
  };
}
