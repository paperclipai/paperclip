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
  todo: "text-status-info border-status-info",
  in_progress: "text-status-running border-status-running",
  in_review: "text-status-warning border-status-warning",
  done: "text-status-success border-status-success",
  cancelled: "text-muted-foreground/60 border-muted-foreground/60",
  blocked: "text-status-error border-status-error",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-status-info",
  in_progress: "text-status-running",
  in_review: "text-status-warning",
  done: "text-status-success",
  cancelled: "text-muted-foreground/60",
  blocked: "text-status-error",
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
  todo: "border border-status-info/30 bg-status-info/12 text-status-info",
  in_progress: "border border-status-running/30 bg-status-running/12 text-status-running",
  in_review: "border border-status-warning/30 bg-status-warning/12 text-status-warning",
  blocked: "border border-status-error/30 bg-status-error/12 text-status-error",
  done: "border border-status-success/30 bg-status-success/12 text-status-success",
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
  critical: "text-status-error",
  high: "text-status-error",
  medium: "text-status-warning",
  low: "text-muted-foreground",
};

export const priorityColorDefault = "text-status-warning";
