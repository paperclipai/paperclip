import type {
  AttentionDetailImage,
  AttentionFeed,
  AttentionFeedQuery,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionWorkspaceRef,
} from "@paperclipai/shared";

export type AttentionListOptions = AttentionFeedQuery;

/**
 * Source kinds the queue can fully resolve in-row. Everything else deep-links
 * to its native surface — the state-derived sources (recovery, failures,
 * budget) expose verbs too rich to safely inline here, so they open their
 * surface.
 *
 * `review` is inline *only when stalled* (PAP-16080 §4.4): a stalled review has
 * no interaction/approval/monitor to open, so the three review verbs
 * (approve / request changes / send back) actuate in-row — the server flips
 * `inlineResolvable` on for exactly those rows (`isInlineResolvable` still ANDs
 * that flag). A *covered* review keeps deep-linking, since its real action
 * lives on the issue (the pending card, a monitor, a live run).
 */
export const INLINE_RESOLVABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "review",
]);

export function isInlineResolvable(item: AttentionItem): boolean {
  return item.inlineResolvable && INLINE_RESOLVABLE_SOURCE_KINDS.has(item.sourceKind);
}

/**
 * Per-source wording only. The icon used to live here too — one glyph per
 * source kind — but rows now borrow the task-status glyph for their kind (see
 * `attentionStatus` below), so a source contributes its *name* and nothing
 * visual.
 */
interface SourceMeta {
  label: string;
}

const SOURCE_META: Record<AttentionSourceKind, SourceMeta> = {
  approval: { label: "Approval" },
  decision: { label: "Decision" },
  issue_thread_interaction: { label: "Decision requested" },
  join_request: { label: "Join request" },
  recovery_action: { label: "Recovery" },
  productivity_review: { label: "Productivity review" },
  blocker_attention: { label: "Blocked dependency" },
  review: { label: "Review" },
  failed_run: { label: "Failed run" },
  budget_alert: { label: "Budget" },
  agent_error_alert: { label: "Agent error" },
};

export function sourceMeta(kind: AttentionSourceKind): SourceMeta {
  return SOURCE_META[kind] ?? { label: kind.replaceAll("_", " ") };
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
// Decision kind → borrowed task status (supersedes the PAP-13409 §4 tone map)
//
// The queue used to run five parallel colour/icon vocabularies (sky / violet /
// rose / amber / neutral), one glyph per source kind, plus an orange-or-red
// severity badge — so two rows demanding the same response from an operator
// could look completely unrelated. The system is flattened to TWO kinds, and
// each one *borrows the task status it corresponds to* instead of declaring a
// palette of its own:
//
//   • blocking — failed run, agent error, blocked dependency, recovery, budget
//       → task status `blocked`    (red, CircleMinus)
//   • review   — approval, confirmation, review, join request, everything else
//       → task status `in_review`  (violet, CircleDot)
//
// Colour and glyph therefore resolve through <StatusGlyph> and the
// `--status-task-icon-*` tokens, so the decision queue and the task list stay
// in lockstep by construction — an operator learns the vocabulary once
// (DESIGN.md principle 5). Source kinds keep their own *wording* ("Approval",
// "Agent error", …); only colour and icon merge.
//
// Severity is no longer chrome. It survives as a filter/group dimension in the
// toolbar, which is where an operator goes when they want to rank by urgency.
// ---------------------------------------------------------------------------

export type AttentionKind = "blocking" | "review";

/** The task status each decision kind renders as. */
export const ATTENTION_KIND_STATUS: Record<AttentionKind, "blocked" | "in_review"> = {
  blocking: "blocked",
  review: "in_review",
};

/** Does this row report something stuck, or something waiting on a verdict? */
export function attentionKind(item: AttentionItem): AttentionKind {
  switch (item.sourceKind) {
    case "decision":
      return "review";
    case "failed_run":
    case "agent_error_alert":
    case "blocker_attention":
    case "recovery_action":
    case "budget_alert":
      return "blocking";
    case "approval":
    case "issue_thread_interaction":
    case "join_request":
    case "review":
    case "productivity_review":
    default:
      return "review";
  }
}

/** Task status a row borrows its glyph and colour from — feeds <StatusGlyph>. */
export function attentionStatus(item: AttentionItem): "blocked" | "in_review" {
  return ATTENTION_KIND_STATUS[attentionKind(item)];
}

/**
 * The task a row belongs to, wherever the feed happens to put it.
 *
 * The feed uses two shapes, and a row that reads only one of them silently
 * drops the task key on the other:
 *   • the subject IS the task (review, blocked dependency) → `subject`
 *     carries the identifier and `relatedIssue` is null;
 *   • the subject hangs off a task (a thread interaction, an issue-scoped
 *     approval) → the task arrives separately as `relatedIssue`.
 *
 * `relatedIssue` wins when both are present: it is the *other* record, so it
 * is the one the subject alone can't tell you about.
 *
 * Returns null for rows genuinely not attached to a task — a hire approval, an
 * agent error — which should show no key rather than a borrowed one.
 *
 * Known gap (server-side, not resolvable here): an approval can carry
 * `subject.metadata.issueId` while `relatedIssue` is null. That is a bare UUID
 * with no key or href, so there is nothing to render; the feed builder has to
 * populate `relatedIssue` for those.
 */
export function attentionTaskRef(item: AttentionItem): { identifier: string; href: string | null } | null {
  const related = item.relatedIssue;
  if (related?.identifier) {
    return { identifier: related.identifier, href: related.href };
  }
  const subject = item.subject;
  if (subject.kind === "issue" && subject.identifier) {
    return { identifier: subject.identifier, href: subject.href };
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
 * The sidebar badge: distinct items that either surfaced today or carry an
 * explicit decide-by deadline that is due today/past. The server computes this
 * before pagination (`deskBadgeCount`), so badge polling can fetch a small
 * first page without losing the company-wide signal.
 */
export function attentionBadgeCount(feed: AttentionFeed | null | undefined): number {
  return feed?.deskBadgeCount ?? 0;
}

// ---------------------------------------------------------------------------
// Today's desk
//
// The default ungrouped desk reflects *what came up*, not a judgement about
// what "can wait". It builds up to three shelves in order:
//   • "Decide now" — only when an item has an explicit decide-by deadline that
//     is due today/past. No deadline set anywhere → no shelf, no claim.
//   • "New today"   — decisions that surfaced today (arrival grouping).
//   • "Earlier"     — everything else, older arrivals.
// The server owns the authoritative decide-by ranking (`sort=decide`) and the
// badge (`deskBadgeCount`); these client helpers mirror that logic *exactly*
// (same UTC day boundaries) so the on-page split and the badge never disagree.
// Keep in lockstep with `server/src/services/attention.ts`
// (`decideOrder`/`isDecideNow`/`isNewToday`).
// ---------------------------------------------------------------------------

const MS_PER_DAY_DECIDE = 24 * 60 * 60 * 1_000;

function startOfUtcDay(now: number): number {
  const value = new Date(now);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function endOfUtcDay(now: number): number {
  return startOfUtcDay(now) + MS_PER_DAY_DECIDE - 1;
}

function endOfUtcWeek(now: number): number {
  const start = startOfUtcDay(now);
  const weekday = new Date(start).getUTCDay();
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday;
  return start + (daysUntilSunday + 1) * MS_PER_DAY_DECIDE - 1;
}

/** [bucket, deadline] — lower bucket / earlier deadline sorts first. */
export function attentionDecideOrder(item: AttentionItem, now: number): [number, number] {
  if (item.decideBy === "today") return [0, endOfUtcDay(now)];
  if (item.decideBy === "this_week") return [0, endOfUtcWeek(now)];
  if (item.decideBy && /^\d{4}-\d{2}-\d{2}$/.test(item.decideBy)) {
    const deadline = Date.parse(`${item.decideBy}T23:59:59.999Z`);
    if (Number.isFinite(deadline)) return [0, deadline];
  }
  if (item.decideBy === "whenever") return [1, Number.MAX_SAFE_INTEGER];
  return [2, Number.MAX_SAFE_INTEGER];
}

/** Due today or overdue — the "Decide now" shelf. Only fires when `decideBy` is set. */
export function attentionIsDecideNow(item: AttentionItem, now: number): boolean {
  const [bucket, deadline] = attentionDecideOrder(item, now);
  return bucket === 0 && deadline <= endOfUtcDay(now);
}

/** Surfaced today (arrival) — the "New today" desk group. Uses UTC day, matching the badge. */
export function attentionIsNewToday(item: AttentionItem, now: number): boolean {
  const ts = new Date(item.createdAt).getTime();
  return Number.isFinite(ts) && ts >= startOfUtcDay(now);
}

/** A rendered desk shelf: shares the shape of {@link AttentionGroup}. */
export interface DeskShelf {
  key: string;
  label: string;
  items: AttentionItem[];
}

/**
 * Build the default (ungrouped) desk layout — the arrival-based grouping that
 * replaced the "Decide now" / "Can wait" split:
 *
 *   • "Decide now" — items with an explicit decide-by deadline due today/past,
 *     ordered by deadline. Omitted entirely when nothing has a due deadline, so
 *     the desk never leads with a shelf built on unset metadata.
 *   • "New today"  — remaining items that surfaced today, newest arrival first.
 *   • "Earlier"    — remaining older arrivals, newest arrival first.
 *
 * A decide-now item is only ever on the "Decide now" shelf, so the three shelves
 * are disjoint and their sizes sum to `items.length`.
 */
export function buildDeskShelves(items: AttentionItem[], now: number): DeskShelf[] {
  const decideNow = items
    .filter((item) => attentionIsDecideNow(item, now))
    .sort((a, b) => {
      const [, aDeadline] = attentionDecideOrder(a, now);
      const [, bDeadline] = attentionDecideOrder(b, now);
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return a.rank - b.rank;
    });
  const rest = items
    .filter((item) => !attentionIsDecideNow(item, now))
    .sort((a, b) => {
      const diff = attentionArrivalTimestamp(b) - attentionArrivalTimestamp(a);
      if (diff !== 0) return diff;
      return a.rank - b.rank;
    });
  const newToday = rest.filter((item) => attentionIsNewToday(item, now));
  const earlier = rest.filter((item) => !attentionIsNewToday(item, now));

  const shelves: DeskShelf[] = [];
  if (decideNow.length > 0) shelves.push({ key: "desk:decide-now", label: "Decide now", items: decideNow });
  if (newToday.length > 0) shelves.push({ key: "desk:new-today", label: "New today", items: newToday });
  if (earlier.length > 0) shelves.push({ key: "desk:earlier", label: "Earlier", items: earlier });
  return shelves;
}

function attentionArrivalTimestamp(item: AttentionItem): number {
  const ts = new Date(item.createdAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

// ---------------------------------------------------------------------------
// Aging shelf (PAP-16032 §4.4) — items idle past the threshold leave the desk.
// ---------------------------------------------------------------------------

/** Default idle threshold before an item drops from the desk to the shelf. */
export const ATTENTION_AGING_DAYS = 30;

/** Milliseconds since the item last saw activity. */
export function attentionIdleMs(item: AttentionItem, now: number): number {
  const ts = new Date(item.activityAt).getTime();
  return Number.isFinite(ts) ? Math.max(0, now - ts) : 0;
}

/** Server-computed shelf membership, including per-queue retention overrides. */
export function attentionIsAging(item: AttentionItem): boolean {
  return item.shelf;
}

/** Idle duration in whole days, for the shelf's "idle N days" label. */
export function attentionIdleDays(item: AttentionItem, now: number): number {
  return Math.floor(attentionIdleMs(item, now) / MS_PER_DAY_DECIDE);
}

// ---------------------------------------------------------------------------
// Decide-by control (triage strip) — the segmented options an operator/agent
// picks from. `date` is handled separately by a date input.
// ---------------------------------------------------------------------------

export type DecideByPreset = "today" | "this_week" | "whenever";

export const DECIDE_BY_OPTIONS: ReadonlyArray<[DecideByPreset, string]> = [
  ["today", "Today"],
  ["this_week", "This week"],
  ["whenever", "Whenever"],
];

/** Human label for any stored `decideBy` value (preset or `YYYY-MM-DD`). */
export function decideByLabel(decideBy: string | null): string {
  if (!decideBy) return "Not set";
  if (decideBy === "today") return "Today";
  if (decideBy === "this_week") return "This week";
  if (decideBy === "whenever") return "Whenever";
  if (/^\d{4}-\d{2}-\d{2}$/.test(decideBy)) {
    const parsed = new Date(`${decideBy}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
      : decideBy;
  }
  return decideBy;
}

// ---------------------------------------------------------------------------
// Date-range chips (PAP-16032 §4.2) — resolve to server-side activity bounds.
// The desk filters `activityAt` server-side (activitySince/Until) rather than
// shipping the whole feed and filtering on the client.
// ---------------------------------------------------------------------------

export type AttentionDateRangeId = "all" | "today" | "yesterday" | "last_7_days" | "this_month" | "custom";

export const ATTENTION_DATE_RANGE_OPTIONS: ReadonlyArray<[AttentionDateRangeId, string]> = [
  ["all", "All"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["last_7_days", "Last 7 days"],
  ["this_month", "This month"],
];

export interface AttentionActivityBounds {
  activitySince?: string;
  activityUntil?: string;
}

/**
 * Resolve a range chip to `{activitySince, activityUntil}` ISO bounds. Uses
 * local calendar boundaries (what the operator means by "today"); `custom`
 * takes the caller's explicit from/to dates.
 */
export function resolveAttentionDateRange(
  range: AttentionDateRangeId,
  now: number,
  custom?: { from?: string | null; to?: string | null },
): AttentionActivityBounds {
  const startOfLocalDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const endOfLocalDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(23, 59, 59, 999);
    return d;
  };
  switch (range) {
    case "all":
      return {};
    case "today":
      return { activitySince: startOfLocalDay(now).toISOString() };
    case "yesterday": {
      const start = startOfLocalDay(now - MS_PER_DAY_DECIDE);
      const end = endOfLocalDay(now - MS_PER_DAY_DECIDE);
      return { activitySince: start.toISOString(), activityUntil: end.toISOString() };
    }
    case "last_7_days":
      return { activitySince: startOfLocalDay(now - 6 * MS_PER_DAY_DECIDE).toISOString() };
    case "this_month": {
      const d = new Date(now);
      const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
      return { activitySince: start.toISOString() };
    }
    case "custom": {
      const bounds: AttentionActivityBounds = {};
      if (custom?.from) {
        const from = new Date(`${custom.from}T00:00:00`);
        if (Number.isFinite(from.getTime())) bounds.activitySince = from.toISOString();
      }
      if (custom?.to) {
        const to = new Date(`${custom.to}T23:59:59.999`);
        if (Number.isFinite(to.getTime())) bounds.activityUntil = to.toISOString();
      }
      return bounds;
    }
    default:
      return {};
  }
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
