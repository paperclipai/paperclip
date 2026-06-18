/**
 * Canonical status & priority color definitions.
 *
 * Every component that renders a status indicator (StatusIcon, StatusBadge,
 * agent status dots, etc.) should import from here so colors stay consistent.
 */

// ---------------------------------------------------------------------------
// Issue status colors
// ---------------------------------------------------------------------------

// PAP-75 brand mapping ("blue = liveness"): todo → amber (queued), in_progress
// → blue (live). See `issueStatusColor` below for the canonical chip palette.
//
// The brand mapping ships behind the "Conference Room Chat" experimental flag
// (PAP-136/PAP-139): each record below also has a `*Classic` variant pinning
// master's hues (todo → blue, in_progress → yellow). Consumers (StatusIcon,
// StatusBadge, NewIssueDialog) select the palette by flag; delete the Classic
// variants when the flag graduates or dies.

/** StatusIcon circle: text + border classes */
export const issueStatusIcon: Record<string, string> = {
  backlog: "text-muted-foreground border-muted-foreground",
  todo: "text-amber-600 border-amber-600 dark:text-amber-400 dark:border-amber-400",
  in_progress: "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400",
  in_review: "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400",
  done: "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400",
  cancelled: "text-neutral-500 border-neutral-500",
  blocked: "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400",
};

/** Master hues for StatusIcon (Conference Room Chat flag OFF). */
export const issueStatusIconClassic: Record<string, string> = {
  ...issueStatusIcon,
  todo: "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400",
  in_progress: "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-amber-600 dark:text-amber-400",
  in_progress: "text-blue-600 dark:text-blue-400",
  in_review: "text-violet-600 dark:text-violet-400",
  done: "text-green-600 dark:text-green-400",
  cancelled: "text-neutral-500",
  blocked: "text-red-600 dark:text-red-400",
};

/** Master hues for text-only issue statuses (Conference Room Chat flag OFF). */
export const issueStatusTextClassic: Record<string, string> = {
  ...issueStatusText,
  todo: "text-blue-600 dark:text-blue-400",
  in_progress: "text-yellow-600 dark:text-yellow-400",
};

export const issueStatusTextDefault = "text-muted-foreground";

// ---------------------------------------------------------------------------
// Badge colors — used by StatusBadge for all entity types
// ---------------------------------------------------------------------------

export const statusBadge: Record<string, string> = {
  // Agent statuses
  active: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  running: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
  scheduled_retry: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300",
  paused: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  idle: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  archived: "bg-muted text-muted-foreground",

  // Goal statuses
  planned: "bg-muted text-muted-foreground",
  achieved: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",

  // Run statuses
  failed: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  timed_out: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  succeeded: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  ok: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300",
  terminated: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",

  // Approval statuses
  pending_approval: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  revision_requested: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  approved: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",

  // Issue statuses — consistent hues with issueStatusIcon above (PAP-75 brand
  // mapping: todo → amber, in_progress → blue "liveness").
  backlog: "bg-muted text-muted-foreground",
  todo: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  in_review: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  done: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  cancelled: "bg-muted text-muted-foreground",
};

/** Master hues for StatusBadge issue entries (Conference Room Chat flag OFF). */
export const statusBadgeClassic: Record<string, string> = {
  ...statusBadge,
  todo: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  in_progress: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
};

export const statusBadgeDefault = "bg-muted text-muted-foreground";

// ---------------------------------------------------------------------------
// Agent status — brand state system (PAP-75)
// ---------------------------------------------------------------------------

export type AgentBadgeColor = "gray" | "blue" | "amber" | "red";

/** Agent status → brand colour name. `active` aliases idle (never assigned). */
export const agentStatusColor: Record<string, AgentBadgeColor> = {
  idle: "gray",
  active: "gray",
  running: "blue",
  paused: "amber",
  error: "red",
};

export const agentStatusColorDefault: AgentBadgeColor = "gray";

/** Brand `.task-chip` styles (1px border) per colour name — light + dark. */
export const agentStatusBadge: Record<AgentBadgeColor, string> = {
  gray: "bg-[#F5F3F0] text-[#52585D] border-[#A8AEB2] dark:bg-[#6e696024] dark:text-[#9A958A] dark:border-[#9e958a73]",
  blue: "bg-[#DBEAFE] text-[#1D4ED8] border-[#2563EB] dark:bg-[#2563eb2e] dark:text-[#2563EB] dark:border-[#2563eb73]",
  amber: "bg-[#FEF3C7] text-[#B45309] border-[#F59E0B] dark:bg-[#f59e0b24] dark:text-[#F59E0B] dark:border-[#f59e0b73]",
  red: "bg-[#FEE2E2] text-[#991B1B] border-[#DC2626] dark:bg-[#dc26262e] dark:text-[#DC2626] dark:border-[#dc262673]",
};

/** Heartbeat-capsule fill (solid) per colour name. gray darkens in dark mode. */
export const agentStatusCapsule: Record<AgentBadgeColor, string> = {
  gray: "bg-[#A8AEB2] dark:bg-[#6E6960]",
  blue: "bg-[#2563EB]",
  amber: "bg-[#F59E0B]",
  red: "bg-[#DC2626]",
};

/** Per-status capsule motion (running pulses, error blinks). Honors reduced-motion. */
export const agentStatusMotion: Record<string, string> = {
  running: "hb-pulse",
  error: "hb-blink",
};

// ---------------------------------------------------------------------------
// Brand `.task-chip` status palette (PAP-75 / status-reference.html)
//
// Colour-named, 1px border, light + dark — values straight from paperclip.ing
// `brand.css`. Shared by the agents section (PAP-80) and the All Projects page
// (PAP-91); PAP-99 brings it to issue/task status chips, adding `violet` for
// `in_review`.
// ---------------------------------------------------------------------------

export type BrandChipColor = "gray" | "blue" | "amber" | "green" | "violet" | "red";

export const brandChipBadge: Record<BrandChipColor, string> = {
  gray: "bg-[#F5F3F0] text-[#52585D] border-[#A8AEB2] dark:bg-[#6e696024] dark:text-[#9A958A] dark:border-[#9e958a73]",
  blue: "bg-[#DBEAFE] text-[#1D4ED8] border-[#2563EB] dark:bg-[#2563eb2e] dark:text-[#2563EB] dark:border-[#2563eb73]",
  amber: "bg-[#FEF3C7] text-[#B45309] border-[#F59E0B] dark:bg-[#f59e0b24] dark:text-[#F59E0B] dark:border-[#f59e0b73]",
  green: "bg-[#DCFCE7] text-[#188A3C] border-[#22C55E] dark:bg-[#22c55e1f] dark:text-[#22C55E] dark:border-[#22c55e73]",
  violet: "bg-[#EDE9FE] text-[#5B21B6] border-[#7C3AED] dark:bg-[#7c3aed2e] dark:text-[#7C3AED] dark:border-[#7c3aed73]",
  red: "bg-[#FEE2E2] text-[#991B1B] border-[#DC2626] dark:bg-[#dc26262e] dark:text-[#DC2626] dark:border-[#dc262673]",
};

/**
 * Issue/task status → brand colour name (PAP-75). `in_progress` is blue
 * (liveness), `todo` amber (queued), `in_review` violet (awaiting review),
 * `done` green, `blocked` red, `backlog`/`cancelled` gray (inert).
 */
export const issueStatusColor: Record<string, BrandChipColor> = {
  backlog: "gray",
  todo: "amber",
  in_progress: "blue",
  in_review: "violet",
  done: "green",
  blocked: "red",
  cancelled: "gray",
};

export const issueStatusColorDefault: BrandChipColor = "gray";

// ---------------------------------------------------------------------------
// Agent status dot — solid background for small indicator dots
// ---------------------------------------------------------------------------

export const agentStatusDot: Record<string, string> = {
  running: "bg-cyan-400 animate-pulse",
  active: "bg-green-400",
  paused: "bg-yellow-400",
  idle: "bg-yellow-400",
  pending_approval: "bg-amber-400",
  error: "bg-red-400",
  archived: "bg-neutral-400",
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
