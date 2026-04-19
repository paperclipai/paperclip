export interface SidebarBadges {
  inbox: number;
  blockers: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  taskDates: {
    today: number;
    tomorrow: number;
    next7Days: number;
  };
}
