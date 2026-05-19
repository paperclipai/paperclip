import type { Agent } from "@paperclipai/shared";

export const AGENT_ORDER_UPDATED_EVENT = "paperclip:agent-order-updated";
export const AGENT_SORT_MODE_UPDATED_EVENT = "paperclip:agent-sort-mode-updated";
const AGENT_ORDER_STORAGE_PREFIX = "paperclip.agentOrder";
const AGENT_SORT_MODE_STORAGE_PREFIX = "paperclip.agentSortMode";
const ANONYMOUS_USER_ID = "anonymous";

export type AgentSidebarSortMode = "top" | "alphabetical" | "recent";

type AgentOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

export type AgentSortModeUpdatedDetail = {
  storageKey: string;
  sortMode: AgentSidebarSortMode;
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeSortMode(value: unknown): AgentSidebarSortMode {
  return value === "alphabetical" || value === "recent" || value === "top" ? value : "top";
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getAgentOrderStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${AGENT_ORDER_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function getAgentSortModeStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${AGENT_SORT_MODE_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function readAgentOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function readAgentSortMode(storageKey: string): AgentSidebarSortMode {
  try {
    return normalizeSortMode(localStorage.getItem(storageKey));
  } catch {
    return "top";
  }
}

export function writeAgentOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentOrderUpdatedDetail>(AGENT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function writeAgentSortMode(storageKey: string, sortMode: AgentSidebarSortMode) {
  const normalized = normalizeSortMode(sortMode);
  try {
    localStorage.setItem(storageKey, normalized);
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentSortModeUpdatedDetail>(AGENT_SORT_MODE_UPDATED_EVENT, {
        detail: { storageKey, sortMode: normalized },
      }),
    );
  }
}

export function sortAgentsByDefaultSidebarOrder(agents: Agent[]): Agent[] {
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const sorted: Agent[] = [];
  const queue = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) continue;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }

  return sorted;
}

export function sortAgentsByStoredOrder(agents: Agent[], orderedIds: string[]): Agent[] {
  if (agents.length === 0) return [];

  const defaultSorted = sortAgentsByDefaultSidebarOrder(agents);
  if (orderedIds.length === 0) return defaultSorted;

  const byId = new Map(defaultSorted.map((agent) => [agent.id, agent]));
  const sorted: Agent[] = [];

  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }

  for (const agent of defaultSorted) {
    if (byId.has(agent.id)) {
      sorted.push(agent);
      byId.delete(agent.id);
    }
  }

  return sorted;
}
