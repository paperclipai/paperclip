export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** Visible unread Mine tasks, retained so optimistic archive can adjust the badge. */
  unreadIssueIds?: string[];
}
