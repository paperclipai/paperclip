import type { IssueOverview, IssueOverviewPullRequest } from "@paperclipai/shared";

/**
 * Project operator snapshot derivation.
 *
 * Pure functions that turn a project's bounded task inventory plus the
 * board-scoped issue overviews into an operator snapshot: outcome progress,
 * Now/Next/Later (or Active/Ready/Backlog when no explicit roadmap labels
 * exist), blockers with canonical owners, completed tasks, and plan/PR
 * discoverability.
 *
 * Honesty rules, enforced here rather than in the view layer:
 * - Lanes are root-outcome first. Execution children nest under their root
 *   inside a disclosure; a child never appears as a lane peer, and child
 *   completion never implies the parent outcome is accepted.
 * - Done and cancelled tasks never appear in the lanes.
 * - "Merged" requires a recorded delivery merge (phase + timestamp) on the
 *   current outcome of a done task. Pull-request state never proves it:
 *   PR sync timestamps are not candidate order, so PR chips stay independent.
 * - Missing merge evidence never proves non-code work; unclassified done
 *   tasks say exactly that. Only explicit non-code delivery kind reads plain.
 *   A done task recorded as code without a verified merge reads exactly that:
 *   code completion, merge unverified.
 * - Delivery coverage is explicit. Loading, partial, and unavailable detail
 *   never render as a confirmed zero or a complete count; only a successful
 *   observation does.
 * - "Needs decision" comes only from canonical awaiting-decision attention.
 *   Stalled reviews and blocking findings are informational, never auto-read
 *   as a human decision.
 * - Plan presence comes from the server's plan-document filter set, never
 *   from list rows (which omit document summaries). Unknown means hidden,
 *   never "0 plans".
 * - Everything derives from the inventory passed in. Nothing here fetches.
 */

export type OperatorRoadmapBucket = "now" | "next" | "later";

export type OperatorLaneKey =
  | OperatorRoadmapBucket
  | "other-open"
  | "active"
  | "ready"
  | "backlog";

/** Bounded inventory page. Mirrors the server list default (ISSUE_LIST_DEFAULT_LIMIT). */
export const PROJECT_OPERATOR_OVERVIEW_PAGE_SIZE = 500;

/** Row caps keep the snapshot scannable; overflow links into the Tasks tab. */
export const PROJECT_OPERATOR_LANE_ROW_LIMIT = 6;
export const PROJECT_OPERATOR_BLOCKER_ROW_LIMIT = 5;
export const PROJECT_OPERATOR_COMPLETED_ROW_LIMIT = 5;

/**
 * Pull-request chips shown inline before the remaining entries move into the
 * row's disclosure. Small on purpose: the row stays scannable while every
 * recorded PR stays reachable one tap or keypress away.
 */
export const PROJECT_OPERATOR_PR_PREVIEW_LIMIT = 2;

/** Minimal linkable task reference for the view layer. */
export interface OperatorTaskRef {
  id: string;
  identifier: string | null;
  title: string;
}

/** Minimal task shape the snapshot needs. The view maps full Issues onto this. */
export interface OperatorSnapshotTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  parentId: string | null;
  /** ISO timestamp. */
  updatedAt: string;
  /** ISO timestamp, null when not completed. */
  completedAt: string | null;
  /** Explicit code/non_code/null delivery kind when the inventory records it. */
  deliveryKind: "code" | "non_code" | null;
  labelNames: string[];
  /** Best-effort detail from the inventory row; null when not recorded. */
  unblockOwnerLabel: string | null;
  unblockAction: string | null;
  reviewStalled: boolean;
  reviewReason: string | null;
  blockedInbox: {
    ownerLabel: string | null;
    actionLabel: string | null;
    actionDetail: string | null;
    needsDecision: boolean;
  } | null;
  blockedByRefs: OperatorTaskRef[];
}

export function isInventoryTruncated(fetchedCount: number): boolean {
  return fetchedCount >= PROJECT_OPERATOR_OVERVIEW_PAGE_SIZE;
}

/** " Now " -> "now"; anything else -> null. */
export function normalizeRoadmapLabelName(name: string): OperatorRoadmapBucket | null {
  const normalized = name.trim().toLowerCase();
  if (normalized === "now" || normalized === "next" || normalized === "later") return normalized;
  return null;
}

/**
 * The task's explicit roadmap bucket, if any. A task carrying several roadmap
 * labels lands in exactly one lane with Now winning over Next over Later.
 */
export function taskRoadmapBucket(task: OperatorSnapshotTask): OperatorRoadmapBucket | null {
  let found: OperatorRoadmapBucket | null = null;
  for (const name of task.labelNames) {
    const bucket = normalizeRoadmapLabelName(name);
    if (!bucket) continue;
    if (bucket === "now") return "now";
    if (bucket === "next" && found !== "next") found = "next";
    if (bucket === "later" && found === null) found = "later";
  }
  return found;
}

export function hasExplicitRoadmapLabels(tasks: readonly OperatorSnapshotTask[]): boolean {
  return tasks.some((task) => taskRoadmapBucket(task) !== null);
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Normalize the explicit delivery-kind discriminator (code / non_code) from
 * an inventory row. Anything else — including absent — is unclassified null:
 * missing merge evidence never proves non-code work.
 */
export function normalizeDeliveryKind(value: unknown): "code" | "non_code" | null {
  return value === "code" || value === "non_code" ? value : null;
}

/**
 * How much delivery detail is actually in hand behind the snapshot.
 *
 * - `complete` needs a successful observation; only then may the snapshot
 *   state a definitive total or an empty "no blockers" result.
 * - `partial` is a failure after an earlier observation: the loaded rows are
 *   real, anything newer may be missing.
 * - `unavailable` is nothing observed (failed, disabled, or never requested).
 * - `loading` is a first load still in flight.
 *
 * Loading, partial, and unavailable are all non-answers and must never render
 * as a confirmed zero or a complete count.
 */
export type OperatorDeliveryCoverage = "complete" | "loading" | "partial" | "unavailable";

export function resolveDeliveryCoverage(args: {
  pending: boolean;
  failed: boolean;
  /** Observation time of the loaded detail. 0 when never loaded. */
  observedAt: number;
}): OperatorDeliveryCoverage {
  if (args.failed) return args.observedAt > 0 ? "partial" : "unavailable";
  if (args.observedAt > 0) return "complete";
  return args.pending ? "loading" : "unavailable";
}

function priorityRank(priority: string): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function compareSnapshotTasks(a: OperatorSnapshotTask, b: OperatorSnapshotTask): number {
  const priority = priorityRank(a.priority) - priorityRank(b.priority);
  if (priority !== 0) return priority;
  if (a.updatedAt === b.updatedAt) return a.id.localeCompare(b.id);
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

export interface OperatorRootOutcome {
  task: OperatorSnapshotTask;
  children: OperatorSnapshotTask[];
}

export interface OperatorLane {
  key: OperatorLaneKey;
  title: string;
  hint: string;
  roots: OperatorRootOutcome[];
}

const ROADMAP_LANE_COPY: Record<OperatorRoadmapBucket, { title: string; hint: string }> = {
  now: { title: "Now", hint: "Root outcomes explicitly labeled now" },
  next: { title: "Next", hint: "Root outcomes explicitly labeled next" },
  later: { title: "Later", hint: "Root outcomes explicitly labeled later" },
};

/**
 * Group open ROOT tasks into lanes. Children nest under their root and never
 * appear as lane peers; children whose parent is outside the inventory are
 * treated as roots since their scope cannot be verified. Done/cancelled
 * tasks are never laned. Without explicit labels, status selects Active
 * (in flight or stuck), Ready (todo), or Backlog.
 */
export function groupProjectTasks(tasks: readonly OperatorSnapshotTask[]): {
  mode: "roadmap" | "status";
  lanes: OperatorLane[];
} {
  const open = tasks.filter((task) => !isTerminalTaskStatus(task.status));
  const openIds = new Set(open.map((task) => task.id));
  const childrenByParent = new Map<string, OperatorSnapshotTask[]>();
  const roots: OperatorSnapshotTask[] = [];
  // Children of any status nest under their open root for precise subtask
  // counts; only open tasks lane as roots. A task whose parent is terminal
  // or outside the inventory lanes as a root itself so it never goes missing.
  for (const task of tasks) {
    const parentId = task.parentId;
    if (parentId !== null && openIds.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(task);
      childrenByParent.set(parentId, siblings);
    } else if (!isTerminalTaskStatus(task.status)) {
      roots.push(task);
    }
  }
  const toOutcome = (task: OperatorSnapshotTask): OperatorRootOutcome => ({
    task,
    children: (childrenByParent.get(task.id) ?? []).sort(compareSnapshotTasks),
  });

  if (hasExplicitRoadmapLabels(tasks)) {
    const buckets: Record<OperatorRoadmapBucket | "other-open", OperatorSnapshotTask[]> = {
      now: [],
      next: [],
      later: [],
      "other-open": [],
    };
    for (const task of roots) {
      const bucket = taskRoadmapBucket(task);
      if (bucket) buckets[bucket].push(task);
      else buckets["other-open"].push(task);
    }
    const lanes: OperatorLane[] = (["now", "next", "later"] as const).map((key) => ({
      key,
      title: ROADMAP_LANE_COPY[key].title,
      hint: ROADMAP_LANE_COPY[key].hint,
      roots: buckets[key].sort(compareSnapshotTasks).map(toOutcome),
    }));
    if (buckets["other-open"].length > 0) {
      lanes.push({
        key: "other-open",
        title: "Other open",
        hint: "Open root outcomes without an explicit roadmap label",
        roots: buckets["other-open"].sort(compareSnapshotTasks).map(toOutcome),
      });
    }
    return { mode: "roadmap", lanes };
  }
  const active: OperatorSnapshotTask[] = [];
  const ready: OperatorSnapshotTask[] = [];
  const backlog: OperatorSnapshotTask[] = [];
  for (const task of roots) {
    if (task.status === "todo") ready.push(task);
    else if (task.status === "backlog") backlog.push(task);
    else active.push(task);
  }
  return {
    mode: "status",
    lanes: [
      {
        key: "active",
        title: "Active",
        hint: "Root outcomes in flight or stuck — not a readiness claim",
        roots: active.sort(compareSnapshotTasks).map(toOutcome),
      },
      {
        key: "ready",
        title: "Ready",
        hint: "Root outcomes to do, unstarted",
        roots: ready.sort(compareSnapshotTasks).map(toOutcome),
      },
      {
        key: "backlog",
        title: "Backlog",
        hint: "Parked ideas — listing is not authorization to start",
        roots: backlog.sort(compareSnapshotTasks).map(toOutcome),
      },
    ],
  };
}

export interface OperatorOutcomeSummary {
  total: number;
  open: number;
  done: number;
  cancelled: number;
  rootCount: number;
  /** Done task ids, most recently completed first. */
  doneTaskIds: string[];
}

export function summarizeProjectOutcomes(tasks: readonly OperatorSnapshotTask[]): OperatorOutcomeSummary {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = tasks
    .filter((task) => task.status === "done")
    .sort((a, b) => {
      const aDone = a.completedAt ?? a.updatedAt;
      const bDone = b.completedAt ?? b.updatedAt;
      if (aDone === bDone) return a.id.localeCompare(b.id);
      return aDone < bDone ? 1 : -1;
    });
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  return {
    total: tasks.length,
    open: tasks.length - done.length - cancelled,
    done: done.length,
    cancelled,
    rootCount: tasks.filter((task) => !task.parentId || !byId.has(task.parentId)).length,
    doneTaskIds: done.map((task) => task.id),
  };
}

export interface OperatorBlocker {
  taskId: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt: string;
  ownerLabel: string | null;
  nextAction: string | null;
  message: string | null;
  blockingRefs: OperatorTaskRef[];
  stalledReview: boolean;
  blockingFindingCount: number;
  /** True only for canonical awaiting-decision attention. */
  needsDecision: boolean;
}

function collectBlockerRefs(
  overviewRefs: ReadonlyArray<OperatorTaskRef>,
  fallbackRefs: readonly OperatorTaskRef[],
  taskId: string,
): OperatorTaskRef[] {
  const refs = new Map<string, OperatorTaskRef>();
  for (const ref of overviewRefs) {
    if (ref.id !== taskId && !refs.has(ref.id)) refs.set(ref.id, { ...ref });
  }
  for (const ref of fallbackRefs) {
    if (ref.id !== taskId && !refs.has(ref.id)) refs.set(ref.id, { ...ref });
  }
  return [...refs.values()];
}

/**
 * Tasks needing operator attention. Each task appears at most once; overview
 * data wins over inventory fields. Ownership stays canonical: the overview
 * blocker owner, then the recorded inbox owner, then the unblock descriptor.
 * "Needs decision" is set only by canonical awaiting-decision attention —
 * stalled reviews and blocking findings are surfaced as information, never
 * auto-read as a human decision.
 */
export function collectProjectBlockers(
  tasks: readonly OperatorSnapshotTask[],
  overviewsById: ReadonlyMap<string, IssueOverview>,
): OperatorBlocker[] {
  const blockers: OperatorBlocker[] = [];
  for (const task of tasks) {
    if (isTerminalTaskStatus(task.status)) continue;
    const overview = overviewsById.get(task.id);
    const overviewBlocker = overview?.blocker ?? null;
    const blocked = overview?.blocked === true || task.status === "blocked";
    const hasSignal =
      blocked ||
      overviewBlocker !== null ||
      task.unblockOwnerLabel !== null ||
      task.reviewStalled ||
      task.blockedInbox !== null ||
      task.blockedByRefs.length > 0 ||
      (overview?.delivery?.blockingFindings ?? 0) > 0;
    if (!hasSignal) continue;

    const blockingRefs = collectBlockerRefs(
      (overview?.blocker?.issues ?? []).map((ref) => ({
        id: ref.id,
        identifier: ref.identifier,
        title: ref.title,
      })),
      task.blockedByRefs,
      task.id,
    );
    const stalledReview = task.reviewStalled || overview?.delivery?.reviewStatus === "stalled";
    blockers.push({
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      ownerLabel: overview?.blocker?.ownerLabel ?? task.blockedInbox?.ownerLabel ?? task.unblockOwnerLabel,
      nextAction:
        overview?.blocker?.nextAction ??
        overview?.delivery?.nextAction ??
        task.blockedInbox?.actionLabel ??
        task.unblockAction ??
        task.reviewReason,
      message: overview?.blocker?.message ?? task.blockedInbox?.actionDetail ?? null,
      blockingRefs,
      stalledReview,
      blockingFindingCount: overview?.delivery?.blockingFindings ?? 0,
      needsDecision: task.blockedInbox?.needsDecision === true,
    });
  }
  blockers.sort((a, b) => {
    if (a.needsDecision !== b.needsDecision) return a.needsDecision ? -1 : 1;
    if (a.status === "blocked" && b.status !== "blocked") return -1;
    if (b.status === "blocked" && a.status !== "blocked") return 1;
    if (a.updatedAt === b.updatedAt) return a.taskId.localeCompare(b.taskId);
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  return blockers;
}

export interface OperatorCompletedTask {
  taskId: string;
  identifier: string | null;
  title: string;
  completedAt: string | null;
  deliveryKind: "code" | "non_code" | null;
  /** True only with a recorded delivery merge on the current outcome. */
  merged: boolean;
  artifactReady: boolean;
  pullRequests: IssueOverviewPullRequest[];
}

/**
 * How a done task's recorded completion reads.
 *
 * - `merged`: the delivery record's merged phase plus a merge timestamp.
 * - `non_code`: explicit non-code delivery kind — a recorded completion that
 *   never claims a merge.
 * - `code_unverified`: explicit code delivery kind without a verified current
 *   merge. Distinct from unclassified on purpose: the work is recorded as
 *   code, only the merge is unproven.
 * - `unclassified`: no recorded delivery kind. Absence of merge evidence is
 *   not evidence of non-code work.
 *
 * Merge verification outranks the recorded kind; PR state never decides here.
 */
export type OperatorCompletionState = "merged" | "non_code" | "code_unverified" | "unclassified";

export function resolveCompletionState(
  completed: Pick<OperatorCompletedTask, "merged" | "deliveryKind">,
): OperatorCompletionState {
  if (completed.merged) return "merged";
  if (completed.deliveryKind === "non_code") return "non_code";
  if (completed.deliveryKind === "code") return "code_unverified";
  return "unclassified";
}

/**
 * Done tasks, most recently completed first. Cancelled tasks are never
 * completed. `merged` is true only when the delivery record for the current
 * outcome reports phase "merged" with a merge timestamp — pull-request state
 * is listed per task for context and never proves the merge, because PR sync
 * timestamps are not candidate order.
 */
export function collectCompletedTasks(
  tasks: readonly OperatorSnapshotTask[],
  overviewsById: ReadonlyMap<string, IssueOverview>,
): OperatorCompletedTask[] {
  return tasks
    .filter((task) => task.status === "done")
    .map((task) => {
      const delivery = overviewsById.get(task.id)?.delivery ?? null;
      return {
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        completedAt: task.completedAt,
        deliveryKind: task.deliveryKind,
        merged: delivery?.phase === "merged" && delivery.mergedAt !== null,
        artifactReady: delivery?.artifactReady === true,
        pullRequests: overviewsById.get(task.id)?.pullRequests ?? [],
      };
    })
    .sort((a, b) => {
      const aDone = a.completedAt ?? "";
      const bDone = b.completedAt ?? "";
      if (aDone === bDone) return a.taskId.localeCompare(b.taskId);
      return aDone < bDone ? 1 : -1;
    });
}

export interface OperatorPullRequestSummary {
  total: number;
  open: number;
  merged: number;
  closedUnmerged: number;
  unknown: number;
}

/** Canonical PR identity for cross-task dedup: URL first, then repo#number. */
export function pullRequestDedupKey(
  issueId: string,
  index: number,
  pr: IssueOverviewPullRequest,
): string {
  if (pr.url) return `url:${pr.url}`;
  if (pr.repository && pr.number !== null) return `repo:${pr.repository}#${pr.number}`;
  return `task:${issueId}#${index}`;
}

/**
 * Pull-request totals across tasks. The same PR can cover several tasks, so
 * entries dedup on canonical identity before counting.
 */
export function summarizePullRequests(
  entries: ReadonlyArray<{ issueId: string; pr: IssueOverviewPullRequest }>,
): OperatorPullRequestSummary {
  const summary: OperatorPullRequestSummary = { total: 0, open: 0, merged: 0, closedUnmerged: 0, unknown: 0 };
  const seen = new Set<string>();
  entries.forEach(({ issueId, pr }, index) => {
    const key = pullRequestDedupKey(issueId, index, pr);
    if (seen.has(key)) return;
    seen.add(key);
    summary.total += 1;
    if (pr.state === "merged") summary.merged += 1;
    else if (pr.state === "open" || pr.state === "draft") summary.open += 1;
    else if (pr.state === "closed") summary.closedUnmerged += 1;
    else summary.unknown += 1;
  });
  return summary;
}
