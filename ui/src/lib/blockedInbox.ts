import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
  IssueBlockedInboxSeverity,
  IssueBlockedInboxState,
} from "@paperclipai/shared";

export type BlockedReasonVariant =
  | "needs_decision"
  | "stalled"
  | "needs_attention"
  | "recovery_required"
  | "external_wait"
  | "owner_paused";

const VARIANT_BY_REASON: Record<IssueBlockedInboxReason, BlockedReasonVariant> = {
  pending_board_decision: "needs_decision",
  pending_user_decision: "needs_decision",
  missing_successful_run_disposition: "needs_decision",
  blocked_chain_stalled: "stalled",
  blocked_by_unassigned_issue: "needs_attention",
  blocked_by_assigned_backlog_issue: "needs_attention",
  blocked_by_cancelled_issue: "needs_attention",
  in_review_without_action_path: "needs_attention",
  invalid_review_participant: "needs_attention",
  open_recovery_issue: "recovery_required",
  external_owner_action: "external_wait",
  blocked_by_uninvokable_assignee: "owner_paused",
};

export const BLOCKED_REASON_VARIANT_ORDER: BlockedReasonVariant[] = [
  "needs_decision",
  "stalled",
  "needs_attention",
  "recovery_required",
  "external_wait",
  "owner_paused",
];

export const BLOCKED_VARIANT_LABELS: Record<BlockedReasonVariant, string> = {
  needs_decision: "Needs decision",
  stalled: "Blocked chain stalled",
  needs_attention: "Needs attention",
  recovery_required: "Recovery required",
  external_wait: "External wait",
  owner_paused: "Owner paused",
};

const REASON_LABELS: Record<IssueBlockedInboxReason, string> = {
  pending_board_decision: "Pending board decision",
  pending_user_decision: "Pending user decision",
  missing_successful_run_disposition: "Pick disposition",
  blocked_chain_stalled: "Blocked chain stalled",
  blocked_by_unassigned_issue: "Unassigned blocker",
  blocked_by_assigned_backlog_issue: "Parked blocker",
  blocked_by_cancelled_issue: "Cancelled blocker",
  in_review_without_action_path: "Review without action path",
  invalid_review_participant: "Invalid review participant",
  open_recovery_issue: "Recovery in progress",
  external_owner_action: "External owner action",
  blocked_by_uninvokable_assignee: "Owner paused",
};

const SEVERITY_RANK: Record<IssueBlockedInboxSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export type BlockedInboxBadgeTone = "muted" | "amber" | "red";

export function blockedReasonVariant(reason: IssueBlockedInboxReason): BlockedReasonVariant {
  return VARIANT_BY_REASON[reason] ?? "needs_attention";
}

export function blockedReasonLabel(reason: IssueBlockedInboxReason): string {
  return REASON_LABELS[reason] ?? "Stopped";
}

export function blockedVariantLabel(variant: BlockedReasonVariant): string {
  return BLOCKED_VARIANT_LABELS[variant];
}

export function blockedSeverityRank(severity: IssueBlockedInboxSeverity): number {
  return SEVERITY_RANK[severity] ?? 9;
}

export function compareBlockedAttention(
  a: IssueBlockedInboxAttention,
  b: IssueBlockedInboxAttention,
): number {
  const sevDiff = blockedSeverityRank(a.severity) - blockedSeverityRank(b.severity);
  if (sevDiff !== 0) return sevDiff;
  const aSince = a.stoppedSinceAt ? new Date(a.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const bSince = b.stoppedSinceAt ? new Date(b.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const sinceDiff = aSince - bSince;
  return Number.isFinite(sinceDiff) ? sinceDiff : 0;
}

export interface BlockedInboxIssueRow {
  issue: Issue;
  attention: IssueBlockedInboxAttention;
  variant: BlockedReasonVariant;
  reasonLabel: string;
  stoppedAtMs: number | null;
}

export type BlockedInboxGroupBy = "attention_tier" | "blocker_type" | "none";
export type BlockedInboxSort = "urgency" | "most_recent" | "longest_stopped";

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = [
  ["attention_tier", "What to do"],
  ["blocker_type", "Blocker type"],
  ["none", "None"],
];

/**
 * P6 surface 1a — the "what must the human do" tier. The Blocked tab groups on this, most-urgent
 * first (Serial Position + Von Restorff put unrouted dead ends at the top where attention lands),
 * collapsing the five shipped `blockedInboxAttention` states into three actionable tiers:
 *
 *  - `attention` — an unrouted dead end (or exhausted-watchdog escalation) a human must act on now.
 *  - `decision`  — a legitimate but visible wait on an approval / interaction / disposition choice.
 *  - `covered`   — progressing under active recovery or an external owner; de-emphasized so it does
 *                  not cry wolf (the incident failure mode was covered work masquerading as stalled).
 */
export type BlockedAttentionTier = "attention" | "decision" | "covered";

const TIER_BY_STATE: Record<IssueBlockedInboxState, BlockedAttentionTier> = {
  needs_attention: "attention",
  awaiting_decision: "decision",
  missing_disposition: "decision",
  recovery_open: "covered",
  external_wait: "covered",
};

export const BLOCKED_TIER_ORDER: BlockedAttentionTier[] = ["attention", "decision", "covered"];

export const BLOCKED_TIER_LABELS: Record<BlockedAttentionTier, string> = {
  attention: "Needs your attention",
  decision: "Awaiting a decision",
  covered: "Covered by active work",
};

/** Sub-header shown under the covered group so it reads as intentionally quiet. */
export const BLOCKED_TIER_SUBTITLES: Partial<Record<BlockedAttentionTier, string>> = {
  covered: "these are progressing — no action needed",
};

export const BLOCKED_TIER_TONE: Record<BlockedAttentionTier, BlockedInboxBadgeTone> = {
  attention: "amber",
  decision: "amber",
  covered: "muted",
};

export function blockedAttentionTier(state: IssueBlockedInboxState): BlockedAttentionTier {
  return TIER_BY_STATE[state] ?? "attention";
}

/**
 * An exhausted-watchdog escalation (P4). Surfaces as a top-priority `attention` row with the red
 * `Escalation` chip. Derived from either the recovery action's `escalated` status or the watchdog's
 * recorded escalation timestamp, whichever the read model carries.
 */
export function isBlockedRowEscalated(issue: Issue): boolean {
  return (
    issue.activeRecoveryAction?.status === "escalated" ||
    Boolean(issue.watchdog?.restorationEscalatedAt)
  );
}

/** The dead-end leaf identifier a needs_attention row names (`sampleBlockerIdentifier` per plan). */
export function blockedRowDeadEndIdentifier(row: BlockedInboxIssueRow): string | null {
  return (
    row.attention.leafIssue?.identifier ??
    row.attention.sampleIssueIdentifier ??
    row.issue.blockerAttention?.sampleBlockerIdentifier ??
    row.issue.blockerAttention?.sampleStalledBlockerIdentifier ??
    null
  );
}

export const BLOCKED_SORT_OPTIONS: readonly [BlockedInboxSort, string][] = [
  ["urgency", "Most urgent"],
  ["most_recent", "Most recent"],
  ["longest_stopped", "Longest stopped"],
];

export interface BlockedInboxGroup {
  variant: BlockedReasonVariant;
  label: string;
  rows: BlockedInboxIssueRow[];
}

export function buildBlockedInboxRows(issues: readonly Issue[]): BlockedInboxIssueRow[] {
  const rows: BlockedInboxIssueRow[] = [];
  for (const issue of issues) {
    const attention = issue.blockedInboxAttention;
    if (!attention) continue;
    rows.push({
      issue,
      attention,
      variant: blockedReasonVariant(attention.reason),
      reasonLabel: blockedReasonLabel(attention.reason),
      stoppedAtMs: attention.stoppedSinceAt ? new Date(attention.stoppedSinceAt).getTime() : null,
    });
  }
  return rows;
}

function issueTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function blockedRowRecencyMs(row: BlockedInboxIssueRow): number {
  return row.stoppedAtMs ?? issueTimestampMs(row.issue.updatedAt) ?? 0;
}

function compareBlockedRowsByTitle(a: BlockedInboxIssueRow, b: BlockedInboxIssueRow): number {
  const byTitle = a.issue.title.localeCompare(b.issue.title);
  if (byTitle !== 0) return byTitle;
  return a.issue.id.localeCompare(b.issue.id);
}

export function compareBlockedRows(
  a: BlockedInboxIssueRow,
  b: BlockedInboxIssueRow,
  sort: BlockedInboxSort = "urgency",
): number {
  if (sort === "most_recent") {
    const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
    if (recencyDiff !== 0) return recencyDiff;
    const attentionDiff = compareBlockedAttention(a.attention, b.attention);
    if (attentionDiff !== 0) return attentionDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  if (sort === "longest_stopped") {
    const aStopped = a.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const bStopped = b.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const stoppedDiff = aStopped - bStopped;
    if (stoppedDiff !== 0) return stoppedDiff;
    const severityDiff = blockedSeverityRank(a.attention.severity) - blockedSeverityRank(b.attention.severity);
    if (severityDiff !== 0) return severityDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  const attentionDiff = compareBlockedAttention(a.attention, b.attention);
  if (attentionDiff !== 0) return attentionDiff;
  const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
  if (recencyDiff !== 0) return recencyDiff;
  return compareBlockedRowsByTitle(a, b);
}

export function sortBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxIssueRow[] {
  return [...rows].sort((a, b) => compareBlockedRows(a, b, sort));
}

export function groupBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxGroup[] {
  const buckets = new Map<BlockedReasonVariant, BlockedInboxIssueRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.variant) ?? [];
    list.push(row);
    buckets.set(row.variant, list);
  }
  const groups: BlockedInboxGroup[] = [];
  for (const variant of BLOCKED_REASON_VARIANT_ORDER) {
    const list = buckets.get(variant);
    if (!list || list.length === 0) continue;
    const sorted = sortBlockedInboxRows(list, sort);
    groups.push({ variant, label: BLOCKED_VARIANT_LABELS[variant], rows: sorted });
  }
  return groups;
}

export interface BlockedInboxTierGroup {
  tier: BlockedAttentionTier;
  label: string;
  subtitle: string | null;
  rows: BlockedInboxIssueRow[];
}

/**
 * Group rows into the three human-action tiers (attention → decision → covered), each internally
 * sorted by the active sort. Within the `attention` tier, exhausted-watchdog escalations float to
 * the top ahead of ordinary dead ends — the escalation is the loudest thing on the board.
 */
export function groupBlockedInboxRowsByTier(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxTierGroup[] {
  const buckets = new Map<BlockedAttentionTier, BlockedInboxIssueRow[]>();
  for (const row of rows) {
    const tier = blockedAttentionTier(row.attention.state);
    const list = buckets.get(tier) ?? [];
    list.push(row);
    buckets.set(tier, list);
  }
  const groups: BlockedInboxTierGroup[] = [];
  for (const tier of BLOCKED_TIER_ORDER) {
    const list = buckets.get(tier);
    if (!list || list.length === 0) continue;
    const sorted = sortBlockedInboxRows(list, sort);
    if (tier === "attention") {
      sorted.sort((a, b) => {
        const escalationDiff =
          Number(isBlockedRowEscalated(b.issue)) - Number(isBlockedRowEscalated(a.issue));
        return escalationDiff;
      });
    }
    groups.push({
      tier,
      label: BLOCKED_TIER_LABELS[tier],
      subtitle: BLOCKED_TIER_SUBTITLES[tier] ?? null,
      rows: sorted,
    });
  }
  return groups;
}

export function blockedRowMatchesSearch(row: BlockedInboxIssueRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.issue.title,
    row.issue.identifier ?? "",
    row.attention.owner.label ?? "",
    row.attention.action.label,
    row.attention.action.detail ?? "",
    row.reasonLabel,
    row.attention.leafIssue?.identifier ?? "",
    row.attention.leafIssue?.title ?? "",
    row.attention.recoveryIssue?.identifier ?? "",
    row.attention.recoveryIssue?.title ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function blockedBadgeTone(rows: readonly BlockedInboxIssueRow[]): BlockedInboxBadgeTone {
  if (rows.length === 0) return "muted";
  let highest: IssueBlockedInboxSeverity = "low";
  for (const row of rows) {
    if (blockedSeverityRank(row.attention.severity) < blockedSeverityRank(highest)) {
      highest = row.attention.severity;
    }
  }
  if (highest === "critical") return "red";
  if (highest === "high") return "amber";
  return "muted";
}

export function formatStoppedAge(stoppedSinceAt: string | null, now: number = Date.now()): string {
  if (!stoppedSinceAt) return "stopped";
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return "stopped";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "stopped just now";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `stopped ${m}m`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return `stopped ${h}h`;
  }
  if (seconds < 86_400 * 7) {
    const d = Math.floor(seconds / 86_400);
    return `stopped ${d}d`;
  }
  if (seconds < 86_400 * 30) {
    const w = Math.floor(seconds / (86_400 * 7));
    return `stopped ${w}w`;
  }
  const mo = Math.floor(seconds / (86_400 * 30));
  return `stopped ${mo}mo`;
}
