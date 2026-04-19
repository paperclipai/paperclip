import type { Project } from "@paperclipai/shared";

export const PROJECT_ORDER_UPDATED_EVENT = "paperclip:project-order-updated";
export const PROJECT_PINS_UPDATED_EVENT = "paperclip:project-pins-updated";
const PROJECT_ORDER_STORAGE_PREFIX = "paperclip.projectOrder";
const PROJECT_PIN_STORAGE_PREFIX = "paperclip.projectPins";
const ANONYMOUS_USER_ID = "anonymous";

type ProjectOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

type ProjectPinsUpdatedDetail = {
  storageKey: string;
  pinnedIds: string[];
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getProjectOrderStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${PROJECT_ORDER_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function getProjectPinStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${PROJECT_PIN_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function readProjectOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeProjectOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProjectOrderUpdatedDetail>(PROJECT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function readPinnedProjectIds(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writePinnedProjectIds(storageKey: string, pinnedIds: string[]) {
  const normalized = normalizeIdList(pinnedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProjectPinsUpdatedDetail>(PROJECT_PINS_UPDATED_EVENT, {
        detail: { storageKey, pinnedIds: normalized },
      }),
    );
  }
}

export function sortProjectsByStoredOrder(projects: Project[], orderedIds: string[]): Project[] {
  if (projects.length === 0) return [];
  if (orderedIds.length === 0) return projects;

  const byId = new Map(projects.map((project) => [project.id, project]));
  const sorted: Project[] = [];

  for (const id of orderedIds) {
    const project = byId.get(id);
    if (!project) continue;
    sorted.push(project);
    byId.delete(id);
  }
  for (const project of byId.values()) {
    sorted.push(project);
  }
  return sorted;
}

export function sortProjectsByPinnedIds(projects: Project[], pinnedIds: string[]): Project[] {
  if (projects.length === 0) return [];
  if (pinnedIds.length === 0) return projects;

  const pinnedIdSet = new Set(pinnedIds);
  const pinned: Project[] = [];
  const unpinned: Project[] = [];

  for (const project of projects) {
    if (pinnedIdSet.has(project.id)) {
      pinned.push(project);
      continue;
    }
    unpinned.push(project);
  }

  return [...pinned, ...unpinned];
}
