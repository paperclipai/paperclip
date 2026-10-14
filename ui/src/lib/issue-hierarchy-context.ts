import type { Issue } from "@paperclipai/shared";

/** Context never promotes an unrelated or orphaned automated task to a result. */
export function includeIssueHierarchyContext(matches: Issue[], context: Issue[]): Issue[] {
  const byId = new Map([...context, ...matches].map((issue) => [issue.id, issue]));
  const result = new Map(matches.map((issue) => [issue.id, issue]));
  for (const match of matches) {
    const visited = new Set([match.id]);
    let parentId = match.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      result.set(parent.id, parent);
      parentId = parent.parentId;
    }
  }
  // Descendants are rooted at matches, not at contextual ancestors.
  const descendantIds = new Set(matches.map((issue) => issue.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of context) {
      if (!descendantIds.has(issue.id) && issue.parentId && descendantIds.has(issue.parentId)) {
        descendantIds.add(issue.id);
        result.set(issue.id, issue);
        changed = true;
      }
    }
  }
  return [...result.values()];
}

/** Fetch each parent once and stop at the collection's current rendering budget. */
export async function loadIssueHierarchyChildren(
  companyId: string,
  matches: Issue[],
  collapsedParents: string[],
  rowBudget: number,
  readChildren: (parentId: string, limit: number, offset: number) => Promise<Issue[]>,
): Promise<{ issues: Issue[]; hasMore: boolean }> {
  const context: Issue[] = [];
  const queue = matches.map((issue) => ({ issue, offset: 0 }));
  const visited = new Set<string>();
  const fetched = new Set<string>();
  let requests = 0;
  while (queue.length > 0 && context.length < rowBudget && requests < rowBudget) {
    const { issue, offset } = queue.shift()!;
    if (offset === 0 && visited.has(issue.id)) continue;
    visited.add(issue.id);
    const collapsed = collapsedParents.includes(issue.id);
    const limit = collapsed ? 1 : Math.min(100, rowBudget - context.length);
    const rows = await readChildren(issue.id, limit, offset);
    requests += 1;
    for (const child of rows) {
      if (child.companyId !== companyId || fetched.has(child.id)) continue;
      fetched.add(child.id);
      context.push(child);
      if (!collapsed) queue.push({ issue: child, offset: 0 });
    }
    if (!collapsed && rows.length === limit) queue.unshift({ issue, offset: offset + rows.length });
  }
  return { issues: context, hasMore: queue.length > 0 };
}
