import type { RecentTaskEntry } from "./recent-tasks";
import { parseIssuePathIdFromPath } from "./issue-reference";

/** Only nest under a readable recent root. Orphans and cyclic links stay reachable. */
export function recentTaskHierarchy(entries: readonly RecentTaskEntry[], pathname: string) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const parents = new Map<string, string>();
  for (const entry of entries) {
    const parentId = entry.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && (parent.subtaskCount ?? 0) > 0) parents.set(entry.id, parent.id);
  }
  // A displayed root owns its direct children. A deeper task can be a second
  // displayed root, so its children must also leave the top-level list.
  const nested = new Map<string, boolean>();
  const flattenedIds = new Set<string>();
  for (const entry of entries) {
    if (nested.has(entry.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current = entry.id;
    while (!nested.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        for (const id of path.slice(cycleStart)) { nested.set(id, false); flattenedIds.add(id); }
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      const parent = parents.get(current);
      if (!parent) { nested.set(current, false); break; }
      current = parent;
    }
    for (const id of path.reverse()) {
      if (nested.has(id)) continue;
      const parent = parents.get(id)!;
      nested.set(id, !flattenedIds.has(parent) && nested.get(parent) === false);
    }
  }
  const nestedIds = new Set(entries.filter(entry => nested.get(entry.id)).map(entry => entry.id));
  const latestVisitByRoot = new Map<string, number>();
  for (const entry of entries) {
    const rootId = nestedIds.has(entry.id) ? parents.get(entry.id)! : entry.id;
    latestVisitByRoot.set(rootId, Math.max(latestVisitByRoot.get(rootId) ?? -Infinity, entry.recordedAt));
  }
  const roots = [...latestVisitByRoot.keys()].map(id => byId.get(id)!);
  const selectedRef = parseIssuePathIdFromPath(pathname);
  const selected = entries.find(entry => entry.id === selectedRef || entry.identifier === selectedRef);
  return { roots, latestVisitByRoot, nestedIds, flattenedIds, selectedChild: selected && nestedIds.has(selected.id) ? selected : undefined };
}
