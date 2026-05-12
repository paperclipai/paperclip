import type { Issue } from "@paperclipai/shared";

export interface IssueTree {
  roots: Issue[];
  childMap: Map<string, Issue[]>;
}

/**
 * Builds a parent→children tree from a flat list of issues.
 *
 * - `roots` contains issues whose parent is absent from the list (or have no
 *   parent at all), so orphaned sub-tasks are always visible at root level.
 * - `childMap` maps each parent id to its direct children in list order.
 */
export function buildIssueTree(items: Issue[]): IssueTree {
  const itemIds = new Set(items.map((i) => i.id));
  const roots = items.filter((i) => !i.parentId || !itemIds.has(i.parentId));
  const childMap = new Map<string, Issue[]>();
  for (const item of items) {
    if (item.parentId && itemIds.has(item.parentId)) {
      const arr = childMap.get(item.parentId) ?? [];
      arr.push(item);
      childMap.set(item.parentId, arr);
    }
  }
  return { roots, childMap };
}

/**
 * Returns the total number of descendants (all depths) of `id` in `childMap`.
 * Used to accurately label collapsed parent badges like "(3 sub-tasks)".
 */
export function countDescendants(id: string, childMap: Map<string, Issue[]>): number {
  const children = childMap.get(id) ?? [];
  return children.reduce((sum, c) => sum + 1 + countDescendants(c.id, childMap), 0);
}

/**
 * Filters a flat issue list to only descendants of `rootId`.
 *
 * This is intentionally useful even when the list contains unrelated issues:
 * stale servers may ignore newer descendant-scoped query params, and the UI
 * must still avoid rendering global issue data in a sub-issue panel.
 */
export function filterIssueDescendants(rootId: string, items: Issue[]): Issue[] {
  const childrenByParentId = new Map<string, Issue[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const siblings = childrenByParentId.get(item.parentId) ?? [];
    siblings.push(item);
    childrenByParentId.set(item.parentId, siblings);
  }

  const descendants: Issue[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const parentId of frontier) {
      for (const child of childrenByParentId.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push(child);
        nextFrontier.push(child.id);
      }
    }
    frontier = nextFrontier;
  }

  return descendants;
}
