import {
  AlertTriangle,
  Ban,
  DollarSign,
  Eye,
  LifeBuoy,
  MessageSquareQuote,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  AttentionDetailImage,
  AttentionFeed,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionWorkspaceRef,
} from "@paperclipai/shared";

/**
 * Source kinds the queue can fully resolve in-row. Everything else deep-links
 * to its native surface — reviews are *never* inline (converged PAP-12628),
 * and the remaining state-derived sources (recovery, failures, budget) expose
 * verbs too rich to safely inline here, so they open their surface.
 */
export const INLINE_RESOLVABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "approval",
  "issue_thread_interaction",
  "join_request",
]);

export function isInlineResolvable(item: AttentionItem): boolean {
  return item.inlineResolvable && INLINE_RESOLVABLE_SOURCE_KINDS.has(item.sourceKind);
}

interface SourceMeta {
  label: string;
  icon: LucideIcon;
}

const SOURCE_META: Record<AttentionSourceKind, SourceMeta> = {
  approval: { label: "Approval", icon: ShieldCheck },
  issue_thread_interaction: { label: "Decision requested", icon: MessageSquareQuote },
  join_request: { label: "Join request", icon: UserPlus },
  recovery_action: { label: "Recovery", icon: LifeBuoy },
  productivity_review: { label: "Productivity review", icon: Zap },
  blocker_attention: { label: "Blocked dependency", icon: Ban },
  review: { label: "Review", icon: Eye },
  failed_run: { label: "Failed run", icon: RefreshCw },
  budget_alert: { label: "Budget", icon: DollarSign },
  agent_error_alert: { label: "Agent error", icon: AlertTriangle },
};

export function sourceMeta(kind: AttentionSourceKind): SourceMeta {
  return SOURCE_META[kind] ?? { label: kind.replaceAll("_", " "), icon: AlertTriangle };
}

interface SeverityStyle {
  /** Left accent bar + dot color. */
  accent: string;
  dot: string;
  label: string;
}

const SEVERITY_STYLE: Record<AttentionSeverity, SeverityStyle> = {
  critical: { accent: "bg-red-500", dot: "bg-red-500", label: "Critical" },
  high: { accent: "bg-orange-500", dot: "bg-orange-500", label: "High" },
  medium: { accent: "bg-yellow-500", dot: "bg-yellow-500", label: "Medium" },
  low: { accent: "bg-blue-500", dot: "bg-blue-500", label: "Low" },
};

export function severityStyle(severity: AttentionSeverity): SeverityStyle {
  return SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low;
}

// ---------------------------------------------------------------------------
// Canonical type → color map (PAP-13409 §4)
//
// The row color is driven by the *kind of decision*, never by severity — one
// map, sourced from `IssueThreadInteractionCard`'s palette so a plan approval or
// confirmation reads identically in the queue and on the issue thread:
//   • confirmations / questions / suggested-tasks / verdicts / reviews → sky
//   • plan approvals                                                   → violet
//   • failures (failed run, agent error)                              → rose
//   • blocked / recovery / budget                                     → amber
//   • join request                                                    → neutral
// Severity only ever surfaces as a small Critical/High badge (never the accent).
// ---------------------------------------------------------------------------

export type AttentionTone = "sky" | "violet" | "rose" | "amber" | "neutral";

export interface AttentionToneStyle {
  /** Left accent bar background. */
  accent: string;
  /** Source-icon tint. */
  icon: string;
  /** Chip / badge border+bg+text (matches the interaction card badge palette). */
  chip: string;
}

const TONE_STYLE: Record<AttentionTone, AttentionToneStyle> = {
  sky: {
    accent: "bg-sky-500",
    icon: "text-sky-600 dark:text-sky-400",
    chip: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
  },
  violet: {
    accent: "bg-violet-500",
    icon: "text-violet-600 dark:text-violet-400",
    chip: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
  },
  rose: {
    accent: "bg-rose-500",
    icon: "text-rose-600 dark:text-rose-400",
    chip: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
  },
  amber: {
    accent: "bg-amber-500",
    icon: "text-amber-600 dark:text-amber-400",
    chip: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
  },
  neutral: {
    accent: "bg-muted-foreground/40",
    icon: "text-muted-foreground",
    chip: "border-border/70 bg-muted/50 text-muted-foreground",
  },
};

/**
 * Resolve the canonical tone for a row. A plan approval is violet regardless of
 * which surface tagged it (approval flow *or* issue-thread confirmation), so we
 * check the T1 detail discriminant first, then fall back to the source kind.
 */
export function attentionTone(item: AttentionItem): AttentionTone {
  if (item.detail?.kind === "plan_approval") return "violet";
  switch (item.sourceKind) {
    case "failed_run":
    case "agent_error_alert":
      return "rose";
    case "blocker_attention":
    case "recovery_action":
    case "budget_alert":
      return "amber";
    case "join_request":
      return "neutral";
    case "approval":
    case "issue_thread_interaction":
    case "review":
    case "productivity_review":
    default:
      return "sky";
  }
}

export function attentionToneStyle(item: AttentionItem): AttentionToneStyle {
  return TONE_STYLE[attentionTone(item)];
}

/**
 * Severity is demoted to a small badge — and only when it is genuinely
 * escalated (Critical/High). Medium/Low return `null` so most rows carry no
 * severity chrome at all.
 */
export function severityBadge(severity: AttentionSeverity): { label: string; className: string } | null {
  if (severity === "critical") {
    return { label: "Critical", className: "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300" };
  }
  if (severity === "high") {
    return { label: "High", className: "border-orange-500/60 bg-orange-500/10 text-orange-700 dark:text-orange-300" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Richer detail line (PAP-13409 §7) — render T1's structured `detail` block into
// a single secondary line under the title (the caller clamps it to 2 lines).
// ---------------------------------------------------------------------------

function quote(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return `“${trimmed}”`;
}

function countNoun(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * A concise human-readable detail line for a row, e.g.
 *   "2 questions — “Which auth provider…”"
 *   "Deploy failed — “exit code 1 on migrate”".
 * Returns `null` when the detail carries nothing beyond the title, so the row
 * can fall back to `whyNow`.
 */
export function attentionDetailLine(item: AttentionItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case "plan_approval":
      return detail.planTitle?.trim() || quote(detail.summaryExcerpt);
    case "approval":
      return quote(detail.summaryExcerpt);
    case "confirmation":
      return quote(detail.promptExcerpt);
    case "checkbox_confirmation": {
      const q = quote(detail.promptExcerpt);
      return q ? `${countNoun(detail.optionCount, "option")} — ${q}` : countNoun(detail.optionCount, "option");
    }
    case "questions": {
      const q = quote(detail.firstQuestionText);
      const label = countNoun(detail.questionCount, "question");
      return q ? `${label} — ${q}` : label;
    }
    case "suggested_tasks": {
      const q = quote(detail.firstTaskTitle);
      const label = countNoun(detail.taskCount, "suggested task");
      return q ? `${label} — ${q}` : label;
    }
    case "item_verdicts": {
      const q = quote(detail.promptExcerpt);
      const label = `${countNoun(detail.itemCount, "item")} to verdict`;
      return q ? `${label} — ${q}` : label;
    }
    case "failed_run":
    case "agent_error": {
      const reason = quote(detail.failureReasonExcerpt);
      if (detail.agentName && reason) return `${detail.agentName} — ${reason}`;
      return detail.agentName ?? reason;
    }
    case "blocker": {
      const b = detail.blockingIssue;
      if (!b) return null;
      const id = b.identifier ? `${b.identifier} ` : "";
      return b.title ? `Blocked by ${id}${b.title}` : b.identifier ? `Blocked by ${b.identifier}` : null;
    }
    case "budget":
      return `${Math.round(detail.observedPercent)}% of budget used ($${detail.amountObserved} / $${detail.amountLimit})`;
    case "generic":
      return quote(detail.summaryExcerpt);
    default:
      return null;
  }
}

/** Screenshot / thumbnail images attached to the detail block, if any. */
export function attentionDetailImages(item: AttentionItem): AttentionDetailImage[] {
  return (item.detail as AttentionItemDetail | null)?.images ?? [];
}

/**
 * Content URL for an attention detail image asset. Already-absolute or data
 * URLs pass through unchanged (server may hand back a CDN URL; stories use data
 * URIs), otherwise we resolve the in-app asset content route.
 */
export function attentionImageUrl(assetId: string): string {
  if (assetId.startsWith("data:") || assetId.startsWith("http")) return assetId;
  return `/api/assets/${assetId}/content`;
}

/**
 * Decisions-only badge count. Every feed row *is* a pending decision (the
 * server drops anything without a decision verb into Activity, per the §0
 * invariant), and mentions/unread never enter the feed — so the row count is
 * the decisions-only number. `/inbox` keeps its own unread count untouched.
 */
export function attentionBadgeCount(feed: AttentionFeed | null | undefined): number {
  return feed?.items.length ?? 0;
}

// ---------------------------------------------------------------------------
// Grouping / sorting / filtering (PAP-13408 — Inbox-style toolbar)
//
// The queue defaults to no grouping, sorted by `activityAt` desc, mirroring the
// `InboxWorkItemGroupBy` pattern in `lib/inbox.ts`. All of these are pure
// functions so the page can re-bucket on the client without refetching, and so
// the logic is unit-tested independently of React.
// ---------------------------------------------------------------------------

export type AttentionGroupBy = "none" | "date" | "type" | "project" | "severity";
export type AttentionSortOrder = "newest" | "oldest";

/** Ordered list used to render the group-by picker (label + value). */
export const ATTENTION_GROUP_BY_OPTIONS: ReadonlyArray<[AttentionGroupBy, string]> = [
  ["none", "None"],
  ["date", "Date"],
  ["type", "Type"],
  ["project", "Project"],
  ["severity", "Severity"],
];

export const ATTENTION_SORT_OPTIONS: ReadonlyArray<[AttentionSortOrder, string]> = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
];

/**
 * Filter selections. Empty arrays mean "no filter" (show everything). The
 * `__none__` sentinel represents rows with no project / workspace.
 */
export interface AttentionFilterState {
  sourceKinds: AttentionSourceKind[];
  projectIds: string[];
  workspaceIds: string[];
  severities: AttentionSeverity[];
}

export const NO_GROUP_SENTINEL = "__none__";

export const defaultAttentionFilterState: AttentionFilterState = {
  sourceKinds: [],
  projectIds: [],
  workspaceIds: [],
  severities: [],
};

export interface AttentionGroup {
  key: string;
  label: string | null;
  items: AttentionItem[];
}

export interface AttentionFilterOptions {
  sourceKinds: AttentionSourceKind[];
  projects: AttentionProjectRef[];
  workspaces: AttentionWorkspaceRef[];
  severities: AttentionSeverity[];
  /** True when at least one row has no project (adds a "No project" option). */
  hasNoProject: boolean;
  /** True when at least one row has no workspace. */
  hasNoWorkspace: boolean;
}

export const ATTENTION_GROUP_BY_KEY = "paperclip:attention:group-by";
export const ATTENTION_SORT_KEY = "paperclip:attention:sort";
export const ATTENTION_FILTERS_KEY_PREFIX = "paperclip:attention:filters";
export const ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:attention:collapsed-groups";

function isAttentionGroupBy(value: unknown): value is AttentionGroupBy {
  return value === "none" || value === "date" || value === "type" || value === "project" || value === "severity";
}

export function loadAttentionGroupBy(): AttentionGroupBy {
  try {
    const raw = localStorage.getItem(ATTENTION_GROUP_BY_KEY);
    return isAttentionGroupBy(raw) ? raw : "none";
  } catch {
    return "none";
  }
}

export function saveAttentionGroupBy(groupBy: AttentionGroupBy) {
  try {
    localStorage.setItem(ATTENTION_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadAttentionSortOrder(): AttentionSortOrder {
  try {
    const raw = localStorage.getItem(ATTENTION_SORT_KEY);
    return raw === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

export function saveAttentionSortOrder(order: AttentionSortOrder) {
  try {
    localStorage.setItem(ATTENTION_SORT_KEY, order);
  } catch {
    // Ignore localStorage failures.
  }
}

function getAttentionFiltersStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_FILTERS_KEY_PREFIX}:${companyId}`;
}

function getAttentionCollapsedGroupsStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

const ALL_SEVERITIES: AttentionSeverity[] = ["critical", "high", "medium", "low"];

export function loadAttentionFilters(companyId: string | null | undefined): AttentionFilterState {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return { ...defaultAttentionFilterState };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaultAttentionFilterState };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sourceKinds: normalizeStringArray(parsed.sourceKinds) as AttentionSourceKind[],
      projectIds: normalizeStringArray(parsed.projectIds),
      workspaceIds: normalizeStringArray(parsed.workspaceIds),
      severities: normalizeStringArray(parsed.severities).filter((s): s is AttentionSeverity =>
        (ALL_SEVERITIES as string[]).includes(s),
      ),
    };
  } catch {
    return { ...defaultAttentionFilterState };
  }
}

export function saveAttentionFilters(
  companyId: string | null | undefined,
  filters: AttentionFilterState,
) {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(filters));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedAttentionGroupKeys(companyId: string | null | undefined): Set<string> {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedAttentionGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function countActiveAttentionFilters(filters: AttentionFilterState): number {
  return (
    filters.sourceKinds.length +
    filters.projectIds.length +
    filters.workspaceIds.length +
    filters.severities.length
  );
}

function attentionActivityTimestamp(item: AttentionItem): number {
  const ts = new Date(item.activityAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Sort by activity time in the requested direction. `rank` is the stable
 * tiebreaker (lower rank = higher priority) so equal-timestamp rows keep the
 * server's escalation order.
 */
export function sortAttentionItems(items: AttentionItem[], order: AttentionSortOrder): AttentionItem[] {
  const sign = order === "oldest" ? -1 : 1;
  return [...items].sort((a, b) => {
    const diff = attentionActivityTimestamp(b) - attentionActivityTimestamp(a);
    if (diff !== 0) return sign * diff;
    return a.rank - b.rank;
  });
}

export function attentionItemMatchesFilters(item: AttentionItem, filters: AttentionFilterState): boolean {
  if (filters.sourceKinds.length > 0 && !filters.sourceKinds.includes(item.sourceKind)) return false;
  if (filters.severities.length > 0 && !filters.severities.includes(item.severity)) return false;
  if (filters.projectIds.length > 0) {
    const projectId = item.project?.id ?? NO_GROUP_SENTINEL;
    if (!filters.projectIds.includes(projectId)) return false;
  }
  if (filters.workspaceIds.length > 0) {
    const workspaceId = item.workspace?.id ?? NO_GROUP_SENTINEL;
    if (!filters.workspaceIds.includes(workspaceId)) return false;
  }
  return true;
}

export function filterAttentionItems(items: AttentionItem[], filters: AttentionFilterState): AttentionItem[] {
  if (countActiveAttentionFilters(filters) === 0) return items;
  return items.filter((item) => attentionItemMatchesFilters(item, filters));
}

/** Distinct filterable dimensions present in the current feed, for the picker. */
export function buildAttentionFilterOptions(items: AttentionItem[]): AttentionFilterOptions {
  const sourceKinds = new Set<AttentionSourceKind>();
  const projects = new Map<string, AttentionProjectRef>();
  const workspaces = new Map<string, AttentionWorkspaceRef>();
  const severities = new Set<AttentionSeverity>();
  let hasNoProject = false;
  let hasNoWorkspace = false;

  for (const item of items) {
    sourceKinds.add(item.sourceKind);
    severities.add(item.severity);
    if (item.project) projects.set(item.project.id, item.project);
    else hasNoProject = true;
    if (item.workspace) workspaces.set(item.workspace.id, item.workspace);
    else hasNoWorkspace = true;
  }

  return {
    sourceKinds: [...sourceKinds].sort((a, b) => sourceMeta(a).label.localeCompare(sourceMeta(b).label)),
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    severities: ALL_SEVERITIES.filter((s) => severities.has(s)),
    hasNoProject,
    hasNoWorkspace,
  };
}

export interface AttentionRenderPlan {
  /** Rows to render per group key (empty for collapsed groups). */
  groupRows: Map<string, AttentionItem[]>;
  snoozedRows: AttentionItem[];
  dismissedRows: AttentionItem[];
  /** True when at least one visible row was left unrendered by the budget. */
  hasMoreRows: boolean;
}

/**
 * Allocate a bounded render budget across the queue in document order — active
 * groups first, then the open curtains (PAP-13784). The feed is uncapped, so
 * the page renders only `limit` rows and grows the budget as the user scrolls;
 * collapsed groups and closed curtains cost nothing.
 */
export function planAttentionRenderRows(options: {
  groups: AttentionGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
  snoozedItems: AttentionItem[];
  snoozedOpen: boolean;
  dismissedItems: AttentionItem[];
  dismissedOpen: boolean;
  limit: number;
}): AttentionRenderPlan {
  let remaining = options.limit;
  let truncated = false;
  const take = (items: AttentionItem[]): AttentionItem[] => {
    const slice = items.slice(0, Math.max(0, remaining));
    remaining -= slice.length;
    if (slice.length < items.length) truncated = true;
    return slice;
  };
  const groupRows = new Map<string, AttentionItem[]>();
  for (const group of options.groups) {
    const collapsed = group.label !== null && options.collapsedGroupKeys.has(group.key);
    groupRows.set(group.key, collapsed ? [] : take(group.items));
  }
  const snoozedRows = options.snoozedOpen ? take(options.snoozedItems) : [];
  const dismissedRows = options.dismissedOpen ? take(options.dismissedItems) : [];
  return { groupRows, snoozedRows, dismissedRows, hasMoreRows: truncated };
}

const DATE_BUCKET_ORDER = ["today", "yesterday", "this_week", "earlier"] as const;
type DateBucket = (typeof DATE_BUCKET_ORDER)[number];

const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  earlier: "Earlier",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Bucket a timestamp relative to `now` using a rolling calendar-day window. */
export function attentionDateBucket(activityAt: string, now: number): DateBucket {
  const ts = new Date(activityAt).getTime();
  if (!Number.isFinite(ts)) return "earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return "today";
  if (ts >= todayStart - MS_PER_DAY) return "yesterday";
  // Rolling 7-day window from the start of today (locale week-start agnostic).
  if (ts >= todayStart - 6 * MS_PER_DAY) return "this_week";
  return "earlier";
}

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * Bucket items into ordered sections. Item order *within* each group is
 * preserved from the input (which the caller sorts first), so the sort toggle
 * still governs intra-group ordering. Group ordering is fixed for date/severity
 * and most-recent-first for type/project.
 */
export function groupAttentionItems(
  items: AttentionItem[],
  groupBy: AttentionGroupBy,
  options: { now?: number } = {},
): AttentionGroup[] {
  if (items.length === 0) return [];

  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "date") {
    const now = options.now ?? Date.now();
    const buckets = new Map<DateBucket, AttentionItem[]>();
    for (const item of items) {
      const bucket = attentionDateBucket(item.activityAt, now);
      const list = buckets.get(bucket) ?? [];
      list.push(item);
      buckets.set(bucket, list);
    }
    return DATE_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
      key: `date:${bucket}`,
      label: DATE_BUCKET_LABELS[bucket],
      items: buckets.get(bucket)!,
    }));
  }

  if (groupBy === "severity") {
    const buckets = new Map<AttentionSeverity, AttentionItem[]>();
    for (const item of items) {
      const list = buckets.get(item.severity) ?? [];
      list.push(item);
      buckets.set(item.severity, list);
    }
    return ALL_SEVERITIES.filter((s) => buckets.has(s)).map((severity) => ({
      key: `severity:${severity}`,
      label: SEVERITY_LABEL[severity],
      items: buckets.get(severity)!,
    }));
  }

  // type / project: group, then order groups by most-recent activity so the
  // freshest section floats to the top (matching Inbox's issue-group ordering).
  const groups = new Map<string, { label: string; items: AttentionItem[]; latest: number }>();
  for (const item of items) {
    const resolved =
      groupBy === "type"
        ? { key: `type:${item.sourceKind}`, label: sourceMeta(item.sourceKind).label }
        : item.project
          ? { key: `project:${item.project.id}`, label: item.project.name }
          : { key: `project:${NO_GROUP_SENTINEL}`, label: "No project" };
    const existing = groups.get(resolved.key);
    const ts = attentionActivityTimestamp(item);
    if (existing) {
      existing.items.push(item);
      existing.latest = Math.max(existing.latest, ts);
    } else {
      groups.set(resolved.key, { label: resolved.label, items: [item], latest: ts });
    }
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => {
      const diff = b.latest - a.latest;
      if (diff !== 0) return diff;
      return a.label.localeCompare(b.label);
    })
    .map(([key, value]) => ({ key, label: value.label, items: value.items }));
}
