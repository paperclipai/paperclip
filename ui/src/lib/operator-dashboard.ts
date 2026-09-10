/**
 * Operator dashboard + decision-view helpers (DASHBOARD/DECISIONS scope).
 *
 * Pure, UI-framework-free derivations over the canonical datasets (issues list,
 * attention feed, decisions list, projects list, and the shared issue-overview
 * read contract owned by the DATA worker). Every rule here is documented where
 * it surfaces so a filter can never silently hide actionable work.
 *
 * Deliberately free of runtime `@paperclipai/shared` imports: the overview
 * types land with the sibling DATA change, so this module references them as
 * types only (erased at build) plus narrow structural picks it defines itself.
 */
import type {
  Agent,
  AttentionItem,
  Issue,
  IssueOverview,
  IssueUnblockOwner,
  Project,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Time window / since-last-visit
// ---------------------------------------------------------------------------

export type OperatorTimeWindowId = "since_visit" | "last_7_days" | "last_30_days";

export const OPERATOR_TIME_WINDOW_OPTIONS: ReadonlyArray<{
  id: OperatorTimeWindowId;
  label: string;
}> = [
  { id: "since_visit", label: "Since last visit" },
  { id: "last_7_days", label: "Last 7 days" },
  { id: "last_30_days", label: "Last 30 days" },
];

const OPERATOR_WINDOW_KEY_PREFIX = "paperclip:operator:time-window";
const OPERATOR_LAST_VISIT_KEY_PREFIX = "paperclip:operator:last-visit";
const OPERATOR_DECISION_VIEW_KEY_PREFIX = "paperclip:operator:decision-view";
const OPERATOR_ENGINEERING_OPEN_KEY_PREFIX = "paperclip:operator:engineering-open";

export const OPERATOR_FIRST_VISIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function windowStorageKey(companyId: string | null | undefined, userId: string | null): string | null {
  if (!companyId) return null;
  return `${OPERATOR_WINDOW_KEY_PREFIX}:${companyId}:${userId ?? "signed-out"}`;
}

function lastVisitStorageKey(companyId: string | null | undefined, userId: string | null): string | null {
  if (!companyId) return null;
  return `${OPERATOR_LAST_VISIT_KEY_PREFIX}:${companyId}:${userId ?? "signed-out"}`;
}

function readStored(key: string | null): string | null {
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string | null, value: string): void {
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is a convenience; a full store or private mode must never
    // break the dashboard.
  }
}
function isTimeWindowId(value: unknown): value is OperatorTimeWindowId {
  return value === "since_visit" || value === "last_7_days" || value === "last_30_days";
}

export function loadOperatorTimeWindow(
  companyId: string | null | undefined,
  userId: string | null,
): OperatorTimeWindowId {
  const stored = readStored(windowStorageKey(companyId, userId));
  return isTimeWindowId(stored) ? stored : "since_visit";
}

export function saveOperatorTimeWindow(
  companyId: string | null | undefined,
  userId: string | null,
  windowId: OperatorTimeWindowId,
): void {
  writeStored(windowStorageKey(companyId, userId), windowId);
}

export function loadOperatorLastVisit(
  companyId: string | null | undefined,
  userId: string | null,
): number | null {
  const stored = readStored(lastVisitStorageKey(companyId, userId));
  if (!stored) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Record the current visit for the next "since last visit" window. */
export function recordOperatorVisit(
  companyId: string | null | undefined,
  userId: string | null,
  now: number = Date.now(),
): void {
  writeStored(lastVisitStorageKey(companyId, userId), String(now));
}

export interface OperatorWindowResolution {
  id: OperatorTimeWindowId;
  /** Inclusive lower bound (ms epoch), or null for an unbounded window. */
  sinceMs: number | null;
  /** Short label for the picker-adjacent line, e.g. "Since Sep 3". */
  label: string;
  /** True when no previous visit was recorded, so the window is a default. */
  isFirstVisit: boolean;
}

function formatWindowDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function resolveOperatorWindow(
  id: OperatorTimeWindowId,
  lastVisitMs: number | null,
  now: number = Date.now(),
): OperatorWindowResolution {
  if (id === "last_7_days") {
    return { id, sinceMs: now - 7 * 24 * 60 * 60 * 1000, label: "Last 7 days", isFirstVisit: false };
  }
  if (id === "last_30_days") {
    return { id, sinceMs: now - 30 * 24 * 60 * 60 * 1000, label: "Last 30 days", isFirstVisit: false };
  }
  if (lastVisitMs !== null && lastVisitMs <= now) {
    return {
      id,
      sinceMs: lastVisitMs,
      label: `Since ${formatWindowDate(lastVisitMs)}`,
      isFirstVisit: false,
    };
  }
  // Honest first-visit default: no recorded visit, so say so and fall back to
  // a bounded recent window rather than pretending to know the visit history.
  return {
    id,
    sinceMs: now - OPERATOR_FIRST_VISIT_WINDOW_MS,
    label: "First visit — showing last 7 days",
    isFirstVisit: true,
  };
}

// ---------------------------------------------------------------------------
// Bounded loading / partial-inventory honesty
// ---------------------------------------------------------------------------

/** How many of the most recently updated tasks the operator sections load. */
export const OPERATOR_ISSUE_LOAD_LIMIT = 200;
/** How many open decisions the dashboard previews (server-ranked). */
export const OPERATOR_DECISION_PREVIEW_LIMIT = 6;
/** How many decided decisions the dashboard previews. */
export const OPERATOR_DECIDED_PREVIEW_LIMIT = 6;
/** Visible cap for the stuck / next / project lists before the "open list" link. */
export const OPERATOR_LIST_PREVIEW_LIMIT = 8;

export interface OperatorInventoryNote {
  truncated: boolean;
  /** Rendered next to any list derived from the bounded fetch. */
  note: string;
}

export function describeOperatorInventory(loadedCount: number, limit: number): OperatorInventoryNote {
  if (loadedCount >= limit) {
    return {
      truncated: true,
      note: `Showing the ${limit} most recently updated tasks — older tasks are not counted here.`,
    };
  }
  return { truncated: false, note: `Covering ${loadedCount} recently updated tasks.` };
}

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------

/** Issue timestamps arrive as ISO strings over the wire despite the Date types. */
export function issueTimeMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Display label for an assignee/creator user id. Null when genuinely unknown. */
export function ownerDisplayLabel(
  kind: "agent" | "user",
  id: string,
  agentNameById: ReadonlyMap<string, string>,
  userLabelById: ReadonlyMap<string, string>,
): string {
  if (kind === "agent") return agentNameById.get(id) ?? "An agent (name unavailable)";
  return userLabelById.get(id) ?? "Someone (name unavailable)";
}

export function describeUnblockOwner(
  owner: IssueUnblockOwner,
  agentNameById: ReadonlyMap<string, string>,
  userLabelById: ReadonlyMap<string, string>,
): string {
  if (owner === "board") return "Board";
  if ("agentId" in owner) return agentNameById.get(owner.agentId) ?? "An agent (name unavailable)";
  return userLabelById.get(owner.userId) ?? "Someone (name unavailable)";
}

// ---------------------------------------------------------------------------
// Delivered outcomes — truthful completion vs verified merge
// ---------------------------------------------------------------------------

export type OutcomeVerification = "merged" | "merge_unverified" | "non_code" | "unlinked";

/**
 * What the task delivers, from the explicit native delivery kind only. Code
 * features are business outcomes too, so this never labels engineering vs
 * business — only Code / No code / Unclassified.
 */
export type OutcomeKind = "code" | "non_code" | "unclassified";

export interface DeliveredOutcome {
  issueId: string;
  identifier: string | null;
  title: string;
  completedAtMs: number;
  verification: OutcomeVerification;
  verificationLabel: string;
  area: OutcomeKind;
  areaLabel: string;
  /** Merge/PR evidence link when the overview records one. */
  evidenceHref: string | null;
  evidenceLabel: string | null;
  projectName: string | null;
  /** True for subtasks (parentId set): shown after root outcomes, never counted as product deliveries. */
  isChild: boolean;
  /** Explicit recovery, supervision, or harness work rather than a product outcome. */
  isSystemTask: boolean;
}

function pickEvidenceUrl(overview: IssueOverview | undefined): { href: string | null; label: string | null } {
  const prs = overview?.pullRequests ?? [];
  const merged = prs.find((pr) => pr.state === "merged" && pr.url);
  if (merged?.url) {
    return {
      href: merged.url,
      label:
        merged.repository && merged.number !== null
          ? `Merged PR ${merged.repository}#${merged.number}`
          : "Merged PR",
    };
  }
  const any = prs.find((pr) => pr.url);
  if (any?.url) {
    const stateLabel = any.state === "unknown" ? "unknown state" : any.state;
    return {
      href: any.url,
      label:
        any.repository && any.number !== null
          ? `PR ${any.repository}#${any.number} (${stateLabel})`
          : `PR (${stateLabel})`,
    };
  }
  return { href: null, label: null };
}

export function classifyOutcome(
  issue: Pick<Issue, "deliveryKind">,
  overview: IssueOverview | undefined,
): { verification: OutcomeVerification; verificationLabel: string; area: OutcomeKind; areaLabel: string } {
  // deliveryKind is explicit on the issue row (integration tree). The absence
  // of PR evidence never proves non-code — it proves nothing was recorded.
  const deliveryKind = issue.deliveryKind ?? null;
  const area: OutcomeKind = deliveryKind ?? "unclassified";
  const areaLabel = area === "code" ? "Code" : area === "non_code" ? "No code" : "Unclassified";

  // Verified only by the current cycle's recorded merge: delivery.phase is
  // "merged" with a mergedAt while the merge is current, and the server
  // nulls delivery on reopen. A historical or mixed-state PR never verifies.
  const delivery = overview?.delivery ?? null;
  if (delivery?.phase === "merged" && delivery.mergedAt !== null) {
    return {
      verification: "merged",
      verificationLabel: "Verified · code merged",
      area: "code",
      areaLabel: "Code",
    };
  }
  if (deliveryKind === "non_code") {
    return {
      verification: "non_code",
      verificationLabel: "Recorded done · non-code outcome",
      area,
      areaLabel,
    };
  }
  const prs = overview?.pullRequests ?? [];
  const mergedPrs = prs.filter((pr) => pr.state === "merged");
  if (mergedPrs.length > 0 && mergedPrs.length === prs.length) {
    return {
      verification: "merge_unverified",
      verificationLabel: "Recorded done · merge recorded, not confirmed for this outcome",
      area: "code",
      areaLabel: "Code",
    };
  }
  if (prs.length > 0) {
    const states = [...new Set(prs.map((pr) => (pr.state === "unknown" ? "unknown state" : pr.state)))].join(", ");
    return {
      verification: "merge_unverified",
      verificationLabel: `Recorded done · merge not evidenced (PR: ${states})`,
      area: "code",
      areaLabel: "Code",
    };
  }
  return {
    verification: "unlinked",
    verificationLabel: "Marked done · delivery evidence not recorded",
    area,
    areaLabel,
  };
}

export function deriveDeliveredOutcomes(
  issues: readonly Issue[],
  byId: ReadonlyMap<string, IssueOverview>,
  sinceMs: number | null,
  projectNameById: ReadonlyMap<string, string>,
): DeliveredOutcome[] {
  const out: DeliveredOutcome[] = [];
  for (const issue of issues) {
    if (issue.status !== "done") continue;
    const completedAtMs = issueTimeMs(issue.completedAt);
    // Without a recorded completion time the task cannot be placed in the
    // window, so it stays out rather than being guessed in.
    if (completedAtMs === null) continue;
    if (sinceMs !== null && completedAtMs < sinceMs) continue;
    const overview = byId.get(issue.id);
    const classification = classifyOutcome(issue, overview);
    const evidence = pickEvidenceUrl(overview);
    // Subtasks and system-generated tasks are real completions, but they are
    // not independent product deliveries: they sort after root outcomes and
    // the section discloses them separately.
    const isChild = issue.parentId !== null;
    const isSystemTask = issue.workMode === "skill_test"
      || issue.originKind === "stale_active_run_evaluation"
      || issue.originKind === "harness_liveness_escalation"
      || issue.originKind === "issue_productivity_review"
      || issue.originKind === "stranded_issue_recovery";
    out.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      completedAtMs,
      verification: classification.verification,
      verificationLabel: classification.verificationLabel,
      area: classification.area,
      areaLabel: classification.areaLabel,
      evidenceHref: evidence.href,
      evidenceLabel: evidence.label,
      projectName: issue.projectId ? (projectNameById.get(issue.projectId) ?? null) : null,
      isChild,
      isSystemTask,
    });
  }
  out.sort((a, b) => {
    const aRank = !a.isChild && !a.isSystemTask ? 0 : 1;
    const bRank = !b.isChild && !b.isSystemTask ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return b.completedAtMs - a.completedAtMs;
  });
  return out;
}
// Stuck tasks — cause, owner, impact from native fields
// ---------------------------------------------------------------------------

export interface StuckTask {
  issueId: string;
  identifier: string | null;
  title: string;
  blockedSinceMs: number | null;
  cause: string | null;
  ownerLabel: string | null;
  impactLabel: string | null;
  projectName: string | null;
  /** True when only the delivery projection says blocked (status not yet blocked). */
  projected: boolean;
}

export function deriveStuckTasks(
  issues: readonly Issue[],
  byId: ReadonlyMap<string, IssueOverview>,
  lookup: {
    agentNameById: ReadonlyMap<string, string>;
    userLabelById: ReadonlyMap<string, string>;
    projectNameById: ReadonlyMap<string, string>;
  },
): StuckTask[] {
  const stuck: StuckTask[] = [];
  for (const issue of issues) {
    const overview = byId.get(issue.id);
    // A delivery blocker can hold a task without status blocked; the overview
    // projection is the canonical signal, so it joins the stuck list too.
    const projected = issue.status !== "blocked" && (overview?.blocked ?? false);
    if (issue.status !== "blocked" && !projected) continue;

    // Cause: overview blocker message first, then the named blocking tasks,
    // then the sampled blocker attention identifiers. Never prose-guessed.
    let cause: string | null = overview?.blocker?.message ?? null;
    if (!cause && issue.blockedBy && issue.blockedBy.length > 0) {
      const names = issue.blockedBy
        .slice(0, 3)
        .map((rel) => rel.identifier ?? rel.title)
        .join(", ");
      const extra = issue.blockedBy.length > 3 ? ` +${issue.blockedBy.length - 3}` : "";
      cause = `Waiting on ${names}${extra}`;
    }
    if (!cause) {
      const sample =
        overview?.blocker?.issues?.[0]?.identifier ??
        overview?.blocker?.issues?.[0]?.title ??
        issue.blockerAttention?.sampleBlockerIdentifier ??
        issue.blockerAttention?.sampleStalledBlockerIdentifier ??
        null;
      cause = sample ? `Blocked · ${sample}` : null;
    }

    // Owner: overview owner label, then the native unblock descriptor, then
    // the current assignee. Absent everywhere stays visibly unknown.
    let ownerLabel: string | null = overview?.blocker?.ownerLabel ?? null;
    if (!ownerLabel && issue.unblockDescriptor) {
      ownerLabel = describeUnblockOwner(issue.unblockDescriptor.owner, lookup.agentNameById, lookup.userLabelById);
    }
    if (!ownerLabel && issue.assigneeAgentId) {
      ownerLabel = ownerDisplayLabel("agent", issue.assigneeAgentId, lookup.agentNameById, lookup.userLabelById);
    }
    if (!ownerLabel && issue.assigneeUserId) {
      ownerLabel = ownerDisplayLabel("user", issue.assigneeUserId, lookup.agentNameById, lookup.userLabelById);
    }

    // Impact from explicit dependency edges only: issue.blocks names the tasks
    // this one directly holds up. Descendant/child counts are not affected
    // work — remaining subtasks are labelled separately below.
    const blockedCount = issue.blocks?.length ?? 0;
    const childTotal = overview?.childCount ?? 0;
    const childDone = overview?.completedChildCount ?? 0;
    const parts: string[] = [];
    if (blockedCount > 0) {
      parts.push(`Blocks ${blockedCount} task${blockedCount === 1 ? "" : "s"}`);
    }
    if (childTotal > 0) {
      // completedChildCount counts done children only (cancelled excluded).
      parts.push(`${childDone} of ${childTotal} subtasks done`);
    }

    stuck.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      blockedSinceMs: issueTimeMs(issue.blockedTransitionAt),
      cause,
      ownerLabel,
      impactLabel: parts.length > 0 ? parts.join(" · ") : null,
      projectName: issue.projectId ? (lookup.projectNameById.get(issue.projectId) ?? null) : null,
      projected,
    });
  }
  // Longest-stuck first; unknown start sorts after dated rows, never first.
  stuck.sort((a, b) => {
    if (a.blockedSinceMs === null && b.blockedSinceMs === null) return 0;
    if (a.blockedSinceMs === null) return 1;
    if (b.blockedSinceMs === null) return -1;
    return a.blockedSinceMs - b.blockedSinceMs;
  });
  return stuck;
}

// ---------------------------------------------------------------------------
// Next candidates — nearest completion first, no invented dates
// ---------------------------------------------------------------------------

export interface NextCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  status: Issue["status"];
  reason: string;
  projectName: string | null;
}

const NEXT_STATUS_RANK: Partial<Record<Issue["status"], number>> = {
  merging: 0,
  ready_to_merge: 1,
  in_review: 2,
  in_progress: 3,
  todo: 4,
};
type NextStatus = "merging" | "ready_to_merge" | "in_review" | "in_progress" | "todo";

function isNextStatus(status: Issue["status"]): status is NextStatus {
  return NEXT_STATUS_RANK[status] !== undefined;
}

function nextCandidateReason(status: NextStatus): string {
  if (status === "merging") return "Merging — landing now";
  if (status === "ready_to_merge") return "Ready to merge — awaiting landing";
  if (status === "in_review") return "In review — awaiting a verdict";
  if (status === "in_progress") return "In progress — actively worked";
  return "Ready — queued to start";
}

export function deriveNextCandidates(
  issues: readonly Issue[],
  byId: ReadonlyMap<string, IssueOverview>,
  projectNameById: ReadonlyMap<string, string>,
  limit: number = OPERATOR_LIST_PREVIEW_LIMIT,
): NextCandidate[] {
  const candidates: Array<NextCandidate & { updatedMs: number | null }> = [];
  for (const issue of issues) {
    if (!isNextStatus(issue.status)) continue;
    // A delivery-projected block keeps the task out of "next" even when its
    // status has not flipped to blocked yet.
    if (byId.get(issue.id)?.blocked ?? false) continue;
    candidates.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      reason: nextCandidateReason(issue.status),
      projectName: issue.projectId ? (projectNameById.get(issue.projectId) ?? null) : null,
      updatedMs: issueTimeMs(issue.updatedAt),
    });
  }
  candidates.sort((a, b) => {
    const rankDiff = (NEXT_STATUS_RANK[a.status] ?? 99) - (NEXT_STATUS_RANK[b.status] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    return (b.updatedMs ?? 0) - (a.updatedMs ?? 0);
  });
  return candidates.slice(0, limit).map(({ updatedMs: _omitted, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Project rollups over the loaded inventory
// ---------------------------------------------------------------------------

export interface ProjectRollup {
  projectId: string | null;
  name: string;
  color: string | null;
  delivered: number;
  blocked: number;
  inReview: number;
  active: number;
  loaded: number;
}

export function deriveProjectRollups(
  issues: readonly Issue[],
  deliveredIds: ReadonlySet<string>,
  projects: ReadonlyArray<Pick<Project, "id" | "name" | "color">>,
  overviews: ReadonlyMap<string, IssueOverview>,
): ProjectRollup[] {
  const meta = new Map<string, { name: string; color: string | null }>();
  for (const project of projects) meta.set(project.id, { name: project.name, color: project.color });
  const byId = new Map<string | null, ProjectRollup>();
  const rollupFor = (projectId: string | null): ProjectRollup => {
    let rollup = byId.get(projectId);
    if (!rollup) {
      const known = projectId ? meta.get(projectId) : undefined;
      rollup = {
        projectId,
        name: known?.name ?? (projectId ? "Project (name unavailable)" : "No project"),
        color: known?.color ?? null,
        delivered: 0,
        blocked: 0,
        inReview: 0,
        active: 0,
        loaded: 0,
      };
      byId.set(projectId, rollup);
    }
    return rollup;
  };
  for (const issue of issues) {
    const rollup = rollupFor(issue.projectId);
    rollup.loaded += 1;
    if (deliveredIds.has(issue.id)) rollup.delivered += 1;
    if (issue.status === "blocked" || (overviews.get(issue.id)?.blocked ?? false)) rollup.blocked += 1;
    else if (issue.status === "in_review") rollup.inReview += 1;
    else if (issue.status === "in_progress" || issue.status === "todo") rollup.active += 1;
  }
  return [...byId.values()].sort((a, b) => {
    if (b.delivered !== a.delivered) return b.delivered - a.delivered;
    if (b.blocked !== a.blocked) return b.blocked - a.blocked;
    return b.loaded - a.loaded;
  });
}

// ---------------------------------------------------------------------------
// Decision views — All / Your decision / System fixing / Needs operator setup
// ---------------------------------------------------------------------------

export type OperatorDecisionView = "all" | "mine" | "fixing" | "setup";

export const OPERATOR_DECISION_VIEWS: ReadonlyArray<{
  id: OperatorDecisionView;
  label: string;
  rule: string;
}> = [
  { id: "all", label: "All", rule: "Every open decision in this queue." },
  {
    id: "mine",
    label: "Your decision",
    rule: "Human-owned actions and board decisions. This view does not change resolution permissions.",
  },
  {
    id: "fixing",
    label: "System fixing",
    rule: "Failures and recovery work. An item may still need an owner or a human action.",
  },
  {
    id: "setup",
    label: "Needs operator setup",
    rule: "Budget, agent, and access alerts. Open an item to see its cause and required action.",
  },
];


const FIXING_VIEW_SOURCE_KINDS: ReadonlySet<AttentionItem["sourceKind"]> = new Set([
  "failed_run",
  "recovery_action",
]);

const SETUP_VIEW_SOURCE_KINDS: ReadonlySet<AttentionItem["sourceKind"]> = new Set([
  "budget_alert",
  "agent_error_alert",
  "join_request",
]);
export type DecisionViewItem = Pick<AttentionItem, "sourceKind" | "resolverAudience"> &
  Partial<Pick<AttentionItem, "subject">>;

export type AttentionOwnership = "human" | "system" | "unknown";

/**
 * Who actually owns the next step on a decision row, from canonical row data.
 * Source kind alone is not enough: failed runs and recovery actions can be
 * human-owned, while reviews and blockers can be system-owned. Resolution
 * order: the server-evaluated resolver audience first, then subject metadata
 * ownership, then source kinds whose native contract requires a human verdict.
 * Unknown ownership is never inferred from explanatory prose.
 */
export function resolveAttentionOwnership(
  item: DecisionViewItem,
  currentUserId: string | null,
): AttentionOwnership {
  const audience = item.resolverAudience ?? null;
  if (audience !== null) {
    if (currentUserId !== null && audience.addresseeUserId === currentUserId) return "human";
    if (audience.effectiveResolverPolicy === "human_only") return "human";
    return "unknown";
  }
  const metadata = item.subject?.metadata;
  const ownerType = metadata !== undefined && typeof metadata.ownerType === "string" ? metadata.ownerType : null;
  if (ownerType === "user" || ownerType === "board") return "human";
  if (ownerType === "agent" || ownerType === "system") return "system";
  switch (item.sourceKind) {
    case "approval":
    case "decision":
    case "join_request":
    case "productivity_review":
    case "budget_alert":
      // Human verdict gates by construction (board decision, access grant,
      // user-assigned review, budget provisioning).
      return "human";
    case "agent_error_alert":
    case "failed_run":
      return "system";
    default:
      return "unknown";
  }
}

/**
 * Every view an item belongs to. "all" always; kind decides fixing/setup;
 * proven human ownership decides "mine". Join requests and budget stops
 * intentionally sit in two views — they need both a verdict and provisioning.
 * Unknown ownership stays in All only, with nothing falsely claimed as yours.
 */
export function attentionItemDecisionViews(
  item: DecisionViewItem,
  currentUserId: string | null,
): Set<OperatorDecisionView> {
  const views: Set<OperatorDecisionView> = new Set(["all"]);
  if (FIXING_VIEW_SOURCE_KINDS.has(item.sourceKind)) views.add("fixing");
  if (SETUP_VIEW_SOURCE_KINDS.has(item.sourceKind)) views.add("setup");
  if (resolveAttentionOwnership(item, currentUserId) === "human") views.add("mine");
  return views;
}


export function filterDecisionView<T extends DecisionViewItem>(
  items: readonly T[],
  view: OperatorDecisionView,
  currentUserId: string | null,
): T[] {
  if (view === "all") return [...items];
  return items.filter((item) => attentionItemDecisionViews(item, currentUserId).has(view));
}

export function countDecisionViews<T extends DecisionViewItem>(
  items: readonly T[],
  currentUserId: string | null,
): Record<OperatorDecisionView, number> {
  const counts: Record<OperatorDecisionView, number> = { all: 0, mine: 0, fixing: 0, setup: 0 };
  for (const item of items) {
    for (const view of attentionItemDecisionViews(item, currentUserId)) counts[view] += 1;
  }
  return counts;
}
export function loadOperatorDecisionView(companyId: string | null | undefined): OperatorDecisionView {
  if (!companyId) return "all";
  try {
    const stored = localStorage.getItem(`${OPERATOR_DECISION_VIEW_KEY_PREFIX}:${companyId}`);
    return stored === "mine" || stored === "fixing" || stored === "setup" ? stored : "all";
  } catch {
    return "all";
  }
}

export function saveOperatorDecisionView(
  companyId: string | null | undefined,
  view: OperatorDecisionView,
): void {
  if (!companyId) return;
  try {
    localStorage.setItem(`${OPERATOR_DECISION_VIEW_KEY_PREFIX}:${companyId}`, view);
  } catch {
    // Same convenience-only policy as the window prefs above.
  }
}

export function loadOperatorEngineeringOpen(companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  try {
    return localStorage.getItem(`${OPERATOR_ENGINEERING_OPEN_KEY_PREFIX}:${companyId}`) === "open";
  } catch {
    return false;
  }
}

export function saveOperatorEngineeringOpen(companyId: string | null | undefined, open: boolean): void {
  if (!companyId) return;
  try {
    localStorage.setItem(
      `${OPERATOR_ENGINEERING_OPEN_KEY_PREFIX}:${companyId}`,
      open ? "open" : "closed",
    );
  } catch {
    // Convenience-only, same as above.
  }
}

// ---------------------------------------------------------------------------
// Small agent-map helpers (Dashboard already builds these; shared for reuse)
// ---------------------------------------------------------------------------

export function buildAgentNameMap(agents: readonly Agent[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const agent of agents ?? []) map.set(agent.id, agent.name);
  return map;
}
