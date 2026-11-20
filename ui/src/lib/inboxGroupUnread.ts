import type { Issue } from "@paperclipai/shared";
import type { InboxGroupedSection } from "./inbox";

// One pass over a group's top-level and nested issues; each distinct unread
// issue is checked against `isExcluded` once.
export function collectInboxGroupUnreadIssueIds(
  group: Pick<InboxGroupedSection, "displayItems" | "childrenByIssueId">,
  isExcluded: (issueId: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const unreadIssueIds: string[] = [];
  const visit = (issue: Issue) => {
    if (!issue.isUnreadForMe || seen.has(issue.id)) return;
    seen.add(issue.id);
    if (!isExcluded(issue.id)) unreadIssueIds.push(issue.id);
  };
  for (const item of group.displayItems) {
    if (item.kind === "issue") visit(item.issue);
  }
  for (const children of group.childrenByIssueId.values()) {
    for (const child of children) visit(child);
  }
  return unreadIssueIds;
}
