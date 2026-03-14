import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AGENT_FILTERS_UPDATED_EVENT,
  DEFAULT_AGENT_FILTERS,
  getAgentFiltersStorageKey,
  readAgentFilters,
  writeAgentFilters,
  type AgentFilters,
  type AgentFiltersUpdatedDetail,
} from "../lib/agent-filters";

export function useAgentFilters(companyId: string | null | undefined) {
  const storageKey = useMemo(() => {
    if (!companyId) return null;
    return getAgentFiltersStorageKey(companyId);
  }, [companyId]);

  const [filters, setFilters] = useState<AgentFilters>(() =>
    storageKey ? readAgentFilters(storageKey) : DEFAULT_AGENT_FILTERS
  );

  // Sync when company changes
  useEffect(() => {
    setFilters(storageKey ? readAgentFilters(storageKey) : DEFAULT_AGENT_FILTERS);
  }, [storageKey]);

  // Multi-tab sync via StorageEvent + custom event
  useEffect(() => {
    if (!storageKey) return;

    const syncFrom = (next: AgentFilters) => {
      setFilters((current) =>
        current.hideIdle === next.hideIdle && current.hidePaused === next.hidePaused
          ? current
          : next
      );
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      syncFrom(readAgentFilters(storageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<AgentFiltersUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      syncFrom(detail.filters);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(AGENT_FILTERS_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AGENT_FILTERS_UPDATED_EVENT, onCustomEvent);
    };
  }, [storageKey]);

  const updateFilter = useCallback(
    (key: "hideIdle" | "hidePaused") => {
      if (!storageKey) return;
      setFilters((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        return next;
      });
    },
    [storageKey],
  );

  // Persist filter changes to localStorage (side effect kept outside state updater)
  useEffect(() => {
    if (!storageKey) return;
    writeAgentFilters(storageKey, filters);
  }, [storageKey, filters]);

  return { filters, updateFilter };
}
