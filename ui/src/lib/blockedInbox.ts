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

/**
 * Action labels the liveness walk emits as a fixed fallback, with no target
 * attached. These ship verbatim on every row that reaches the same branch.
 */
const GENERIC_BLOCKED_ACTION_LABELS: ReadonlySet<string> = new Set([
  "Inspect blocker chain",
  "Inspect blocked chain",
]);

/**
 * The one detail string the stall branch pairs with its fallback label
 * (`server/src/services/issues.ts`, the `blocked_chain_stalled` branch). A row
 * carrying a *different* detail under the same label is carrying information
 * the label alone does not, so it is not suppressed.
 */
const GENERIC_BLOCKED_ACTION_DETAIL =
  "Inspect the stalled blocker or review leaf and make the next owner/action explicit.";

/**
 * The server's recommended next step, or `null` when it would add nothing the
 * row does not already show.
 *
 * Every `blockedInboxAttention` carries an `action`, but not every action is
 * information. `blocked_chain_stalled` is the fallback branch of the attention
 * build (`server/src/services/issues.ts`, ~L6391): it fires when no leaf
 * produced a specific finding, and it ships one hardcoded label, one hardcoded
 * detail string and `owner: { type: "unknown" }` for every such row.
 *
 * Measured on the live board 2026-09-28, four times. The board drains between
 * runs and the totals move ~40% (76 attended rows on the first pass, 60 on the
 * last); the properties the rule depends on are properties of the server
 * branch, so they do not move at all. Latest pass, 74 blocked rows with 60
 * carrying an action:
 *
 *   `Inspect blocker chain`  51 of 60 (85%)  `leafIssue: null` on all 51
 *   `Answer confirmation`      5 rows
 *   `Choose disposition`       2 rows
 *   `Assign blocker`           1 row   `leafIssue` -> K-20119
 *   `Resume parked blocker`    1 row   `leafIssue` -> K-20035
 *
 * On all 51 stalled rows simultaneously: `leafIssue` is null, `recoveryIssue`
 * is null, `owner.type` is "unknown", and the detail string is one
 * byte-identical string. That degeneracy is what makes the action noise, and
 * it survives the queue draining to zero.
 *
 * So the fallback is suppressed for two independent reasons. It cannot name a
 * target, because `leafIssue` is null on all 51 and the detail string is byte
 * identical across them — so the instruction "inspect the stalled blocker or
 * review leaf" points at nothing. And the rows are already bucketed under a
 * group header reading "Blocked chain stalled", so repeating it per row is ~51
 * copies of the header. The other 9 actions are specific and are shown.
 *
 * **The rule is "does this action carry a target?", not "is this a known
 * string?"** It keys on the label only to recognise the fallback — the reason
 * cannot be the signal, because the finding branch reuses `finding.state` as
 * the reason *and* as the switch that picks the label, so a reason branch would
 * have had to enumerate every label the server might ever emit. A row is
 * suppressed only when all three hold:
 *
 *   1. the label is a known fallback, and
 *   2. `leafIssue` is null, and
 *   3. the detail is the canonical stall string (or absent).
 *
 * Break any one and the action surfaces. That is the re-opening path, and it is
 * implemented rather than described: the design guide promises exactly these
 * three conditions, so the guide and the function cannot drift apart.
 */
export function blockedRowActionLabel(attention: IssueBlockedInboxAttention): string | null {
  const label = attention.action?.label?.trim();
  if (!label) return null;
  if (!GENERIC_BLOCKED_ACTION_LABELS.has(label)) return label;
  if (attention.leafIssue) return label;
  if (attention.action?.detail && attention.action.detail !== GENERIC_BLOCKED_ACTION_DETAIL) {
    return label;
  }
  return null;
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

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = [
  ["blocker_type", "Blocker type"],
  ["none", "None"],
];

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

/**
 * The tokens a row can be found by, which are exactly the tokens the row shows.
 *
 * This is the parity contract the inbox needs. It previously indexed
 * `attention.action.label`, `attention.action.detail` and `reasonLabel` while
 * the row rendered only `blockedVariantLabel(variant)` — so a search for
 * "Parked blocker" matched K-20036 and the row then displayed "Needs
 * attention", and a search for "Answer confirmation" matched six rows that
 * showed no action at all. Filtering on text the user cannot see makes the
 * search box lie about the result.
 *
 * Every token below is now rendered somewhere on the row: `reasonLabel` by the
 * reason chip, `actionLabel` beneath it, `title`/`identifier` by the row's
 * identity, and `groupLabel` by the group header the row is bucketed under.
 * `actionLabel` goes through `blockedRowActionLabel` so a suppressed action is
 * not searchable either — otherwise the suppression would hide the text on
 * screen while leaving it findable.
 *
 * `attention.leafIssue` and `attention.recoveryIssue` are deliberately absent.
 * No render path draws them — `BlockedInboxView` has no blocker-chain or
 * linked-blocker row content — so indexing them let a search match a leaf or
 * recovery title the row never showed, the same defect class as `action.detail`.
 * Re-add them only in the same change that renders them.
 *
 * Two tokens are conditional, because whether the row displays them is a
 * property of how the inbox is configured, not of the row:
 *
 * - `groupLabel` is only indexed when the caller says the group header is
 *   rendered. With grouping set to "None" there is no header, so indexing
 *   "Needs attention" would let a search match a row that reads only "Parked
 *   blocker" — the same lie, reached through the other door.
 * - `ownerLabel` is the *resolved* owner name, because that is what the row
 *   draws. `attention.owner.label` is null on the finding-driven path while the
 *   row still shows the assignee name resolved from `owner.agentId`
 *   (`server/src/services/issues.ts` ~L6345), so indexing the raw field alone
 *   made a displayed name unfindable.
 */
export interface BlockedRowSearchContext {
  /**
   * The variant label, but only when the row's group header is actually
   * rendered. Omit it — or pass `null` — when grouping is off.
   */
  groupLabel?: string | null;
  /** The owner name exactly as the row resolves and displays it. */
  ownerLabel?: string | null;
}

export function blockedRowSearchTokens(
  row: BlockedInboxIssueRow,
  context: BlockedRowSearchContext = {},
): string[] {
  const attention = row.attention;
  return [
    row.issue.title,
    row.issue.identifier ?? "",
    context.ownerLabel ?? attention.owner.label ?? "",
    blockedRowActionLabel(attention) ?? "",
    row.reasonLabel,
    context.groupLabel ?? "",
  ].filter((token) => token.length > 0);
}

export function blockedRowMatchesSearch(
  row: BlockedInboxIssueRow,
  query: string,
  context: BlockedRowSearchContext = {},
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = blockedRowSearchTokens(row, context).join(" ").toLowerCase();
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
