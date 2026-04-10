const ISSUE_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "QA",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function formatIssueStatusLabel(status: string): string {
  return ISSUE_STATUS_LABELS[status]
    ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
