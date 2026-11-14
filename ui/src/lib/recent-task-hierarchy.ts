import type { RecentTaskEntry } from "./recent-tasks";
import { parseIssuePathIdFromPath } from "./issue-reference";

/** Only nest under a readable recent root. Orphans and cyclic links stay reachable. */
export function recentTaskHierarchy(entries: readonly RecentTaskEntry[], pathname: string) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const nestedIds = new Set<string>();
  for (const entry of entries) {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    if (parent && parent.id !== entry.id && (parent.subtaskCount ?? 0) > 0
      && (!parent.parentId || !byId.has(parent.parentId))) nestedIds.add(entry.id);
  }
  const selectedRef = parseIssuePathIdFromPath(pathname);
  const selected = entries.find(entry => entry.id === selectedRef || entry.identifier === selectedRef);
  return { nestedIds, selectedChild: selected && nestedIds.has(selected.id) ? selected : undefined };
}
