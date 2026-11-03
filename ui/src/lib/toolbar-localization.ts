import { t } from "@/i18n";

const keys: Record<string, string> = {
  Inbox: "inbox",
  Unread: "unread",
  "Needs attention": "needsAttention",
  "All tasks": "allTasks",
  Name: "name",
  Updated: "updated",
  Created: "created",
  "Target date": "targetDate",
  "Most agents": "mostAgents",
  "Most stars": "mostStars",
  "Most forks": "mostForks",
  "Recently updated": "recentlyUpdated",
  Alphabetical: "alphabetical",
  Installed: "installed",
  Discover: "discover",
  "My Skills": "mySkills",
};

/** Render only the fixed toolbar labels; canonical filter values stay unchanged. */
export function toolbarLabel(label: string): string {
  return Object.hasOwn(keys, label) ? t(`oct26Toolbar.${keys[label]}`) : label;
}
