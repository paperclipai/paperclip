import {
  readRecentSelectionIds,
  trackRecentSelectionId,
} from "./recent-selections";

// Per-browser record of skills recently opened in Skill Studio, powering the
// "Recently visited" section of the Studio landing (PAP-13150). Same
// localStorage-list pattern as recent-projects.ts / recent-assignees.ts.
const STORAGE_KEY = "paperclip:recent-studio-skills";

export function getRecentStudioSkillIds(): string[] {
  return readRecentSelectionIds(STORAGE_KEY);
}

export function trackRecentStudioSkill(skillId: string): void {
  trackRecentSelectionId(STORAGE_KEY, skillId);
}
