export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** Pending issue thread interactions awaiting a human (founder) decision. */
  awaitingHuman: number;
}
