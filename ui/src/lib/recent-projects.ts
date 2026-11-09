import {
  readRecentSelectionIds,
  trackRecentSelectionId,
} from "./recent-selections";

const STORAGE_KEY = "paperclip:recent-projects";

export function getRecentProjectIds(): string[] {
  return readRecentSelectionIds(STORAGE_KEY);
}

/** Undefined means no history; an empty string remembers an explicit No project. */
export function getLastProjectId(companyId: string): string | undefined {
  try {
    return localStorage.getItem(`${STORAGE_KEY}:${companyId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function trackRecentProject(projectId: string, companyId?: string): void {
  trackRecentSelectionId(STORAGE_KEY, projectId);
  if (companyId) {
    try {
      localStorage.setItem(`${STORAGE_KEY}:${companyId}`, projectId);
    } catch {
      // Selection remains usable when browser storage is unavailable.
    }
  }
}
