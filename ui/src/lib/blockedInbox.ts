import { t } from "@/i18n";
import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
  IssueBlockedInboxSeverity,
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
  get needs_decision() { return t("localizationIssueLists.blocked_needs_decision", { defaultValue: "Needs decision" }); },
  get stalled() { return t("localizationIssueLists.blocked_stalled", { defaultValue: "Blocked chain stalled" }); },
  get needs_attention() { return t("localizationIssueLists.blocked_needs_attention", { defaultValue: "Needs attention" }); },
  get recovery_required() { return t("localizationIssueLists.blocked_recovery_required", { defaultValue: "Recovery required" }); },
  get external_wait() { return t("localizationIssueLists.blocked_external_wait", { defaultValue: "External wait" }); },
  get owner_paused() { return t("localizationIssueLists.blocked_owner_paused", { defaultValue: "Owner paused" }); },
};

const REASON_LABELS: Record<IssueBlockedInboxReason, string> = {
  get pending_board_decision() { return t("localizationIssueLists.blocked_pending_board_decision", { defaultValue: "Pending board decision" }); },
  get pending_user_decision() { return t("localizationIssueLists.blocked_pending_user_decision", { defaultValue: "Pending user decision" }); },
  get missing_successful_run_disposition() { return t("localizationIssueLists.blocked_missing_successful_run_disposition", { defaultValue: "Pick disposition" }); },
  get blocked_chain_stalled() { return t("localizationIssueLists.blocked_blocked_chain_stalled", { defaultValue: "Blocked chain stalled" }); },
  get blocked_by_unassigned_issue() { return t("localizationIssueLists.blocked_blocked_by_unassigned_issue", { defaultValue: "Unassigned blocker" }); },
  get blocked_by_assigned_backlog_issue() { return t("localizationIssueLists.blocked_blocked_by_assigned_backlog_issue", { defaultValue: "Parked blocker" }); },
  get blocked_by_cancelled_issue() { return t("localizationIssueLists.blocked_blocked_by_cancelled_issue", { defaultValue: "Cancelled blocker" }); },
  get in_review_without_action_path() { return t("localizationIssueLists.blocked_in_review_without_action_path", { defaultValue: "Review without action path" }); },
  get invalid_review_participant() { return t("localizationIssueLists.blocked_invalid_review_participant", { defaultValue: "Invalid review participant" }); },
  get open_recovery_issue() { return t("localizationIssueLists.blocked_open_recovery_issue", { defaultValue: "Recovery in progress" }); },
  get external_owner_action() { return t("localizationIssueLists.blocked_external_owner_action", { defaultValue: "External owner action" }); },
  get blocked_by_uninvokable_assignee() { return t("localizationIssueLists.blocked_blocked_by_uninvokable_assignee", { defaultValue: "Owner paused" }); },
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
  return REASON_LABELS[reason] ?? t("status.stopped");
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

export type BlockedInboxGroupBy = "blocker_type" | "none";
export type BlockedInboxSort = "urgency" | "most_recent" | "longest_stopped";

function localizedOption<T extends string>(value: T, label: () => string): [T, string] {
  const option: [T, string] = [value, ""];
  Object.defineProperty(option, 1, { get: label, enumerable: true });
  return option;
}

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = [
  localizedOption("blocker_type", () => t("localizationIssueLists.blockedOption_blocker_type", { defaultValue: "Blocker type" })),
  localizedOption("none", () => t("localizationIssueLists.blockedOption_none", { defaultValue: "None" })),
];

export const BLOCKED_SORT_OPTIONS: readonly [BlockedInboxSort, string][] = [
  localizedOption("urgency", () => t("localizationIssueLists.blockedOption_urgency", { defaultValue: "Most urgent" })),
  localizedOption("most_recent", () => t("localizationIssueLists.blockedOption_most_recent", { defaultValue: "Most recent" })),
  localizedOption("longest_stopped", () => t("localizationIssueLists.blockedOption_longest_stopped", { defaultValue: "Longest stopped" })),
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
  if (!stoppedSinceAt) return t("localizationIssueLists.stopped", { defaultValue: "stopped" });
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return t("localizationIssueLists.stopped", { defaultValue: "stopped" });
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t("localizationIssueLists.stoppedNow", { defaultValue: "stopped just now" });
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return t("localizationIssueLists.stoppedm", { defaultValue: "stopped {{count}}m", count: m });
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return t("localizationIssueLists.stoppedh", { defaultValue: "stopped {{count}}h", count: h });
  }
  if (seconds < 86_400 * 7) {
    const d = Math.floor(seconds / 86_400);
    return t("localizationIssueLists.stoppedd", { defaultValue: "stopped {{count}}d", count: d });
  }
  if (seconds < 86_400 * 30) {
    const w = Math.floor(seconds / (86_400 * 7));
    return t("localizationIssueLists.stoppedw", { defaultValue: "stopped {{count}}w", count: w });
  }
  const mo = Math.floor(seconds / (86_400 * 30));
  return t("localizationIssueLists.stoppedmo", { defaultValue: "stopped {{count}}mo", count: mo });
}
