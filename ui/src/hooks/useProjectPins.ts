import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@paperclipai/shared";
import {
  getProjectPinStorageKey,
  PROJECT_PINS_UPDATED_EVENT,
  readPinnedProjectIds,
  sortProjectsByPinnedIds,
  writePinnedProjectIds,
} from "../lib/project-order";

type UseProjectPinsParams = {
  projects: Project[];
  companyId: string | null | undefined;
  userId: string | null | undefined;
};

type ProjectPinsUpdatedDetail = {
  storageKey: string;
  pinnedIds: string[];
};

function areEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function filterPinnedIds(projects: Project[], pinnedIds: string[]) {
  if (pinnedIds.length === 0) return [];
  const projectIds = new Set(projects.map((project) => project.id));
  return pinnedIds.filter((id) => projectIds.has(id));
}

export function useProjectPins({ projects, companyId, userId }: UseProjectPinsParams) {
  const storageKey = useMemo(() => {
    if (!companyId) return null;
    return getProjectPinStorageKey(companyId, userId);
  }, [companyId, userId]);

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    if (!storageKey) return [];
    return filterPinnedIds(projects, readPinnedProjectIds(storageKey));
  });

  useEffect(() => {
    const nextIds = storageKey ? filterPinnedIds(projects, readPinnedProjectIds(storageKey)) : [];
    setPinnedIds((current) => (areEqual(current, nextIds) ? current : nextIds));
  }, [projects, storageKey]);

  useEffect(() => {
    if (!storageKey) return;

    const syncFromIds = (ids: string[]) => {
      const nextIds = filterPinnedIds(projects, ids);
      setPinnedIds((current) => (areEqual(current, nextIds) ? current : nextIds));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      syncFromIds(readPinnedProjectIds(storageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectPinsUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      syncFromIds(detail.pinnedIds);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_PINS_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_PINS_UPDATED_EVENT, onCustomEvent);
    };
  }, [projects, storageKey]);

  const orderedProjects = useMemo(
    () => sortProjectsByPinnedIds(projects, pinnedIds),
    [projects, pinnedIds],
  );

  const persistPinnedIds = useCallback(
    (ids: string[]) => {
      const filtered = filterPinnedIds(projects, ids);
      setPinnedIds((current) => (areEqual(current, filtered) ? current : filtered));
      if (storageKey) {
        writePinnedProjectIds(storageKey, filtered);
      }
    },
    [projects, storageKey],
  );

  const togglePinned = useCallback(
    (projectId: string) => {
      const nextIds = pinnedIds.includes(projectId)
        ? pinnedIds.filter((id) => id !== projectId)
        : [...pinnedIds, projectId];
      persistPinnedIds(nextIds);
    },
    [persistPinnedIds, pinnedIds],
  );

  return {
    orderedProjects,
    pinnedIds,
    togglePinned,
  };
}
