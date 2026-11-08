import { localizedOptions } from "./display-options";
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
  get "needs_decision"() { return t("display:meta_229276829a0f"); },
  get "stalled"() { return t("display:meta_df8fc50b1792"); },
  get "needs_attention"() { return t("display:meta_a126722ec044"); },
  get "recovery_required"() { return t("display:meta_3d6d38a4bfc8"); },
  get "external_wait"() { return t("display:meta_f06421d15591"); },
  get "owner_paused"() { return t("display:meta_1e7c2fbd0e84"); },
};

const REASON_LABELS: Record<IssueBlockedInboxReason, string> = {
  get "pending_board_decision"() { return t("display:meta_7f2c74fe26e9"); },
  get "pending_user_decision"() { return t("display:meta_00de6c320cce"); },
  get "missing_successful_run_disposition"() { return t("display:meta_c5a895897343"); },
  get "blocked_chain_stalled"() { return t("display:meta_df8fc50b1792"); },
  get "blocked_by_unassigned_issue"() { return t("display:meta_3df9c330e562"); },
  get "blocked_by_assigned_backlog_issue"() { return t("display:meta_803f4d5f8990"); },
  get "blocked_by_cancelled_issue"() { return t("display:meta_4b84136cf0b6"); },
  get "in_review_without_action_path"() { return t("display:meta_14970f18d0b9"); },
  get "invalid_review_participant"() { return t("display:meta_9d9d3ca3c9b6"); },
  get "open_recovery_issue"() { return t("display:meta_c8f61cc412ed"); },
  get "external_owner_action"() { return t("display:meta_8561cbcade03"); },
  get "blocked_by_uninvokable_assignee"() { return t("display:meta_1e7c2fbd0e84"); },
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
  return REASON_LABELS[reason] ?? t("display:copy_ac652f1676c7");
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

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = localizedOptions([
  ["blocker_type", "option_188926af4da9"],
  ["none", "option_6eef6648406c"],
]);

export const BLOCKED_SORT_OPTIONS: readonly [BlockedInboxSort, string][] = localizedOptions([
  ["urgency", "option_83922b9c177f"],
  ["most_recent", "option_88ac2cf7230b"],
  ["longest_stopped", "option_9a3ae7c71ed8"],
]);

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
  if (!stoppedSinceAt) return t("display:copy_9c54ae7d53c9");
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return t("display:copy_9c54ae7d53c9");
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t("display:copy_65a780d787ac");
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return t("display:copy_a1b094a04fe2", { value0: m });
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return t("display:copy_c40325bbaf0e", { value0: h });
  }
  if (seconds < 86_400 * 7) {
    const d = Math.floor(seconds / 86_400);
    return t("display:copy_1e019cc72cfb", { value0: d });
  }
  if (seconds < 86_400 * 30) {
    const w = Math.floor(seconds / (86_400 * 7));
    return t("display:copy_80639280e572", { value0: w });
  }
  const mo = Math.floor(seconds / (86_400 * 30));
  return t("display:copy_54641a4cabcd", { value0: mo });
}
