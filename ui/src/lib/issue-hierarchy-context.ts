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

/** Batch each breadth-first frontier; leaf-heavy lists need one read, not one per task. */
export async function loadIssueHierarchyChildren(
  companyId: string,
  matches: Issue[],
  collapsedParents: string[],
  rowBudget: number,
  readChildren: (parentIds: string[], limit: number, offset: number, oneChildPerParent?: boolean) => Promise<Issue[]>,
): Promise<{ issues: Issue[]; hasMore: boolean }> {
  const context: Issue[] = [];
  const visited = new Set<string>();
  const fetched = new Set<string>();
  const collapsed = new Set(collapsedParents);
  let requests = 0;
  let loadedRows = 0;
  let probes = 0;
  let moreCollapsedMarkers = false;
  let frontier = [...new Set(matches.map((issue) => issue.id))];
  while (frontier.length > 0 && loadedRows < rowBudget) {
    const next: string[] = [];
    const collapsedFrontier = frontier.filter((id) => collapsed.has(id) && !visited.has(id));
    const collapsedIds = collapsedFrontier.slice(0, Math.max(0, rowBudget - probes));
    moreCollapsedMarkers ||= collapsedIds.length < collapsedFrontier.length;
    collapsedFrontier.forEach((id) => visited.add(id));
    // One child is enough to keep a collapsed parent's expand affordance. These
    // markers must not spend the budget reserved for expanded, readable rows.
    for (let start = 0; start < collapsedIds.length; start += 100) {
      const batch = collapsedIds.slice(start, start + 100);
      const markers = await readChildren(batch, batch.length, 0, true);
      probes += batch.length;
      for (const child of markers) {
        if (child.companyId !== companyId || fetched.has(child.id)) continue;
        fetched.add(child.id);
        context.push(child);
      }
    }
    for (let start = 0; start < frontier.length; start += 100) {
      const parentIds = frontier.slice(start, start + 100).filter((id) => !visited.has(id));
      if (parentIds.length === 0) continue;
      parentIds.forEach((id) => visited.add(id));
      let offset = 0;
      while (loadedRows < rowBudget) {
        if (requests >= rowBudget) return { issues: context, hasMore: true };
        requests += 1;
        const limit = Math.min(100, rowBudget - loadedRows);
        const rows = await readChildren(parentIds, limit, offset);
        for (const child of rows) {
          if (child.companyId !== companyId || fetched.has(child.id)) continue;
          fetched.add(child.id);
          context.push(child);
          loadedRows += 1;
          if (!visited.has(child.id)) next.push(child.id);
        }
        if (rows.length < limit) break;
        offset += rows.length;
        if (loadedRows >= rowBudget) return { issues: context, hasMore: true };
      }
      if (loadedRows >= rowBudget && (start + 100 < frontier.length || next.length > 0)) return { issues: context, hasMore: true };
    }
    frontier = [...new Set(next)].filter((id) => !visited.has(id));
  }
  return { issues: context, hasMore: moreCollapsedMarkers || frontier.length > 0 };
}
