import {
  readRecentSelectionIds,
  trackRecentSelectionId,
} from "./recent-selections";

const STORAGE_KEY = "paperclip:recent-projects";

export function getRecentProjectIds(): string[] {
  return readRecentSelectionIds(STORAGE_KEY);
}

export function trackRecentProject(projectId: string): void {
  trackRecentSelectionId(STORAGE_KEY, projectId);
}
