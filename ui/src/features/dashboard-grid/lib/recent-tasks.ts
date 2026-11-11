export function selectRecentTasks<TIssue extends { updatedAt: Date | string }>(
  issues: readonly TIssue[],
  limit: number,
): TIssue[] {
  const dated = issues.map((issue) => ({ issue, updatedAt: new Date(issue.updatedAt).getTime() }));
  dated.sort((a, b) => b.updatedAt - a.updatedAt);
  return dated.slice(0, limit).map((entry) => entry.issue);
}
