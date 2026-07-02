import type { Issue } from "@paperclipai/shared";

function buildChildrenByParentId(issues: Issue[]): Map<string, Issue[]> {
  const childrenByParentId = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const children = childrenByParentId.get(issue.parentId) ?? [];
    children.push(issue);
    childrenByParentId.set(issue.parentId, children);
  }
  return childrenByParentId;
}

export function collectIssueIdsWithDescendants(seedIssues: Issue[], allIssues: Issue[]): Set<string> {
  const childrenByParentId = buildChildrenByParentId(allIssues);
  const selectedIds = new Set(seedIssues.map((issue) => issue.id));
  const stack = [...selectedIds];

  while (stack.length > 0) {
    const issueId = stack.pop();
    if (!issueId) continue;
    for (const child of childrenByParentId.get(issueId) ?? []) {
      if (selectedIds.has(child.id)) continue;
      selectedIds.add(child.id);
      stack.push(child.id);
    }
  }

  return selectedIds;
}

export function sumIssueValuesWithDescendants(
  seedIssues: Issue[],
  allIssues: Issue[],
  valueOf: (issue: Issue) => number,
): number {
  const ids = collectIssueIdsWithDescendants(seedIssues, allIssues);
  return allIssues.reduce((total, issue) => ids.has(issue.id) ? total + valueOf(issue) : total, 0);
}

export function buildIssueValueWithDescendantsMap(
  issues: Issue[],
  valueOf: (issue: Issue) => number,
): Map<string, number> {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const childrenByParentId = buildChildrenByParentId(issues);
  const totals = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (issueId: string): number => {
    const existing = totals.get(issueId);
    if (existing !== undefined) return existing;
    if (visiting.has(issueId)) return 0;
    visiting.add(issueId);
    const issue = byId.get(issueId);
    let total = issue ? valueOf(issue) : 0;
    for (const child of childrenByParentId.get(issueId) ?? []) {
      total += visit(child.id);
    }
    visiting.delete(issueId);
    totals.set(issueId, total);
    return total;
  };

  for (const issue of issues) {
    visit(issue.id);
  }

  return totals;
}
