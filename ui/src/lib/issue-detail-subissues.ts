export function shouldRenderRichSubIssuesSection(childIssuesLoading: boolean, childIssueCount: number): boolean {
  return childIssuesLoading || childIssueCount > 0;
}
