/**
 * Canonical status & priority color definitions.
 *
 * Every component that renders a status indicator (StatusIcon, StatusBadge,
 * agent status dots, etc.) should import from here so colors stay consistent.
 */

// ---------------------------------------------------------------------------
// Issue status colors
// ---------------------------------------------------------------------------

/** StatusIcon circle: text + border classes */
export const issueStatusIcon: Record<string, string> = {
  backlog: "text-muted-foreground border-muted-foreground",
  todo: "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400",
  in_progress: "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400",
  in_review: "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400",
  done: "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400",
  cancelled: "text-neutral-500 border-neutral-500",
  blocked: "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-blue-600 dark:text-blue-400",
  in_progress: "text-yellow-600 dark:text-yellow-400",
  in_review: "text-violet-600 dark:text-violet-400",
  done: "text-green-600 dark:text-green-400",
  cancelled: "text-neutral-500",
  blocked: "text-red-600 dark:text-red-400",
};

export const issueStatusTextDefault = "text-muted-foreground";

// ---------------------------------------------------------------------------
// Badge colors — used by StatusBadge for all entity types
// ---------------------------------------------------------------------------

export const statusBadge: Record<string, string> = {
  // Agent statuses
  active: "border border-status-success/30 bg-status-success/12 text-status-success",
  running: "border border-status-running/30 bg-status-running/12 text-status-running",
  scheduled_retry: "border border-status-info/30 bg-status-info/12 text-status-info",
  paused: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  idle: "border border-border text-muted-foreground",
  archived: "bg-muted text-muted-foreground",

  // Goal statuses
  planned: "bg-muted text-muted-foreground",
  achieved: "border border-status-success/30 bg-status-success/12 text-status-success",
  completed: "border border-status-success/30 bg-status-success/12 text-status-success",

  // Run statuses
  failed: "border border-status-error/30 bg-status-error/12 text-status-error",
  timed_out: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  succeeded: "border border-status-success/30 bg-status-success/12 text-status-success",
  ok: "border border-status-success/30 bg-status-success/12 text-status-success",
  warning: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  error: "border border-status-error/30 bg-status-error/12 text-status-error",
  info: "border border-status-info/30 bg-status-info/12 text-status-info",
  terminated: "border border-status-error/30 bg-status-error/12 text-status-error",
  pending: "border border-status-warning/30 bg-status-warning/12 text-status-warning",

  // Approval statuses
  pending_approval: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  revision_requested: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  approved: "border border-status-success/30 bg-status-success/12 text-status-success",
  rejected: "border border-status-error/30 bg-status-error/12 text-status-error",

  // Issue statuses — consistent hues with issueStatusIcon above
  backlog: "bg-muted text-muted-foreground",
  todo: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  in_progress: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  in_review: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  done: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  cancelled: "bg-muted text-muted-foreground",
};

export const statusBadgeDefault = "bg-muted text-muted-foreground";

// ---------------------------------------------------------------------------
// Agent status dot — solid background for small indicator dots
// ---------------------------------------------------------------------------

export const agentStatusDot: Record<string, string> = {
  running: "bg-status-running animate-pulse",
  active: "bg-status-success",
  paused: "bg-status-warning",
  idle: "bg-muted-foreground/50",
  pending_approval: "bg-status-warning",
  error: "bg-status-error",
  archived: "bg-muted-foreground/40",
};

export const agentStatusDotDefault = "bg-neutral-400";

// ---------------------------------------------------------------------------
// Priority colors
// ---------------------------------------------------------------------------

export const priorityColor: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-blue-600 dark:text-blue-400",
};

export const priorityColorDefault = "text-yellow-600 dark:text-yellow-400";
