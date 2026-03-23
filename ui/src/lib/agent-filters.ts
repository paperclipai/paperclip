export const AGENT_FILTERS_UPDATED_EVENT = "paperclip:agent-filters-updated";
const AGENT_FILTERS_STORAGE_PREFIX = "paperclip.agentFilters";

export type AgentFilters = { hideIdle: boolean; hidePaused: boolean };

export const DEFAULT_AGENT_FILTERS: AgentFilters = { hideIdle: false, hidePaused: false };

export type AgentFiltersUpdatedDetail = {
  storageKey: string;
  filters: AgentFilters;
};

function normalize(value: unknown): AgentFilters {
  if (typeof value !== "object" || value === null) return DEFAULT_AGENT_FILTERS;
  const obj = value as Record<string, unknown>;
  return {
    hideIdle: obj.hideIdle === true,
    hidePaused: obj.hidePaused === true,
  };
}

export function getAgentFiltersStorageKey(companyId: string): string {
  return `${AGENT_FILTERS_STORAGE_PREFIX}:${companyId}`;
}

export function readAgentFilters(storageKey: string): AgentFilters {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_AGENT_FILTERS;
    return normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_AGENT_FILTERS;
  }
}

export function writeAgentFilters(storageKey: string, filters: AgentFilters) {
  const normalized = normalize(filters);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentFiltersUpdatedDetail>(AGENT_FILTERS_UPDATED_EVENT, {
        detail: { storageKey, filters: normalized },
      }),
    );
  }
}
