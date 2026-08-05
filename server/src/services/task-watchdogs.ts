import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
  issueWorkProducts,
} from "@paperclipai/db";
import type { IssueWatchdog, IssueWatchdogSummary, TaskWatchdogRecoveryBatch } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { TASK_WATCHDOG_ORIGIN_KIND, taskWatchdogScopeAllowsIssueMutation } from "./task-watchdog-scope.js";

const TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX = "task_watchdog_stop:";
const TASK_WATCHDOG_SUBTREE_MAX_DEPTH = 100;
const TASK_WATCHDOG_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TASK_WATCHDOG_WAKE_REQUEST_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const TASK_WATCHDOG_TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
// Grace window after an issue is created/assigned during which its first
// assignment run/wake may have been enqueued but is not yet visible to a
// watchdog evaluation (the eval can race the issue's own assignment run).
// Within this window a non-terminal issue that has never completed a run is
// treated as not-yet-stopped so the evaluation does not produce a
// false-positive stopped-subtree review. The periodic watchdog reconciler
// re-evaluates after the window, so a genuinely idle issue still triggers.
const TASK_WATCHDOG_FIRST_RUN_GRACE_MS = 15_000;
const TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS = 3;

type ActorFields = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type IssueWatchdogUpsertInput = {
  agentId: string;
  instructions?: string | null;
  actor?: ActorFields;
};

type IssueWatchdogRow = typeof issueWatchdogs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type TaskWatchdogClassifierIssue = Pick<
  IssueRow,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "parentId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "originKind"
  | "updatedAt"
> & {
  // Optional so existing callers/tests that do not care about the first-run
  // grace window keep working; the pending-first-run guard is skipped when
  // it (or `evaluatedAt`) is absent.
  createdAt?: Date | string | null;
  latestCommentAt?: Date | string | null;
  latestDocumentAt?: Date | string | null;
  latestWorkProductAt?: Date | string | null;
};

export type TaskWatchdogClassifierPath = {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
};

export type TaskWatchdogClassifierWaitingPath = {
  companyId: string;
  issueId: string;
  id?: string | null;
  kind?: string | null;
  status: string;
};

export type TaskWatchdogClassifierRelation = {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
};

export type TaskWatchdogClassifierConfig = Pick<
  IssueWatchdogSummary,
  "companyId" | "issueId" | "lastReviewedFingerprint"
> & {
  lastReviewedStopSnapshot?: TaskWatchdogStopSnapshot | null;
};

export type TaskWatchdogStoppedLeaf = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerIssueIds: string[];
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
  updatedAt: string;
  latestCommentAt: string | null;
  latestDocumentAt: string | null;
  latestWorkProductAt: string | null;
};

export type TaskWatchdogMaterialLeaf = Pick<
  TaskWatchdogStoppedLeaf,
  | "issueId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "blockerIssueIds"
  | "pendingInteractionIds"
  | "pendingApprovalIds"
>;

export type TaskWatchdogWaitsByIssueId = Record<string, {
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
}>;

export type TaskWatchdogStopSnapshot = {
  version: 2 | 3;
  fingerprint: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  nonLeafStatuses?: Array<{ issueId: string; status: string }>;
};

type TaskWatchdogPendingInteractionsByIssueId = Record<string, Array<{
  id: string;
  kind: string | null;
}>>;

export type TaskWatchdogClassifierResult =
  | {
    state: "not_applicable";
    reason: string;
    includedIssueIds: string[];
  }
  | {
    state: "live";
    reason: string;
    includedIssueIds: string[];
    liveIssueIds: string[];
  }
  | {
    state: "pending_first_run";
    reason: string;
    includedIssueIds: string[];
    pendingIssueIds: string[];
  }
  | {
    state: "already_reviewed";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  }
  | {
    state: "stopped";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  };

export type TaskWatchdogClassifierInput = {
  watchdog: TaskWatchdogClassifierConfig;
  issues: TaskWatchdogClassifierIssue[];
  activeRuns?: TaskWatchdogClassifierPath[];
  queuedWakeRequests?: TaskWatchdogClassifierPath[];
  blockers?: TaskWatchdogClassifierRelation[];
  pendingInteractions?: TaskWatchdogClassifierWaitingPath[];
  pendingApprovals?: TaskWatchdogClassifierWaitingPath[];
  // Timestamp the evaluation reads its snapshot at. When provided together
  // with a positive `firstRunGraceMs`, the classifier suppresses a
  // stopped-subtree verdict for issues created within the grace window that
  // have never completed a run (their first assignment run/wake may not yet
  // be visible). Omit to disable the guard (legacy behavior).
  evaluatedAt?: Date | string | null;
  firstRunGraceMs?: number | null;
  // Ids of included issues that have at least one run in a terminal status.
  // Such issues are never treated as "pending first run" — they have
  // demonstrably executed, so a stop is genuine rather than a snapshot race.
  completedRunIssueIds?: string[];
};

type TaskWatchdogWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type TaskWatchdogWakeup = (
  agentId: string,
  opts?: TaskWatchdogWakeupOptions,
) => Promise<{ id: string } | null>;

export type TaskWatchdogServiceDeps = {
  enqueueWakeup?: TaskWatchdogWakeup;
};

function normalizeInstructions(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function summarizeIssueWatchdog(row: IssueWatchdogRow): IssueWatchdogSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    watchdogAgentId: row.watchdogAgentId,
    instructions: row.instructions,
    status: row.status as IssueWatchdogSummary["status"],
    watchdogIssueId: row.watchdogIssueId,
    lastObservedFingerprint: row.lastObservedFingerprint,
    lastReviewedFingerprint: row.lastReviewedFingerprint,
    restorationFingerprint: row.restorationFingerprint,
    restorationVerificationPending: row.restorationVerificationPending,
    restorationAttemptCount: row.restorationAttemptCount,
    restorationAttempts: row.restorationAttempts,
    restorationEscalatedAt: row.restorationEscalatedAt,
    lastTriggeredAt: row.lastTriggeredAt,
    lastCompletedAt: row.lastCompletedAt,
    triggerCount: row.triggerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIssueWatchdog(row: IssueWatchdogRow): IssueWatchdog {
  return {
    ...summarizeIssueWatchdog(row),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    updatedByRunId: row.updatedByRunId,
  };
}

function issueUpdatedAtIso(issue: Pick<TaskWatchdogClassifierIssue, "updatedAt">) {
  return issue.updatedAt instanceof Date
    ? issue.updatedAt.toISOString()
    : new Date(String(issue.updatedAt)).toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pathIssueIds(paths: TaskWatchdogClassifierPath[] | undefined, companyId: string) {
  return new Set(
    (paths ?? [])
      .filter((path) => path.companyId === companyId && typeof path.issueId === "string" && path.issueId.length > 0)
      .map((path) => path.issueId as string),
  );
}

function waitingPathIds(
  paths: TaskWatchdogClassifierWaitingPath[] | undefined,
  companyId: string,
  issueId: string,
) {
  return (paths ?? [])
    .filter((path) => path.companyId === companyId && path.issueId === issueId)
    .map((path) => path.id ?? `${path.status}:${path.issueId}`)
    .sort();
}

function stableStopFingerprint(input: {
  companyId: string;
  watchedIssueId: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  nonLeafStatuses: Array<{ issueId: string; status: string }>;
}) {
  const payload = JSON.stringify({
    version: 3,
    companyId: input.companyId,
    watchedIssueId: input.watchedIssueId,
    materialLeaves: input.materialLeaves,
    waitsByIssueId: input.waitsByIssueId,
    nonLeafStatuses: input.nonLeafStatuses,
  });
  return `task_watchdog_stop:${createHash("sha256").update(payload).digest("hex")}`;
}

function materialLeaf(leaf: TaskWatchdogStoppedLeaf): TaskWatchdogMaterialLeaf {
  return {
    issueId: leaf.issueId,
    status: leaf.status,
    assigneeAgentId: leaf.assigneeAgentId,
    assigneeUserId: leaf.assigneeUserId,
    blockerIssueIds: leaf.blockerIssueIds,
    pendingInteractionIds: leaf.pendingInteractionIds,
    pendingApprovalIds: leaf.pendingApprovalIds,
  };
}

function parseStopSnapshot(value: unknown): TaskWatchdogStopSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TaskWatchdogStopSnapshot>;
  if (
    (candidate.version !== 2 && candidate.version !== 3) ||
    typeof candidate.fingerprint !== "string" ||
    !Array.isArray(candidate.materialLeaves) ||
    !candidate.waitsByIssueId ||
    typeof candidate.waitsByIssueId !== "object"
  ) return null;
  return candidate as TaskWatchdogStopSnapshot;
}

// Snapshots loaded from jsonb columns come back with Postgres's normalized key
// order, so equality checks against freshly built snapshots must not depend on
// object key order.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      )
      : val);
}

function isShrinkOfReviewedSnapshot(
  current: TaskWatchdogStopSnapshot,
  reviewed: TaskWatchdogStopSnapshot | null | undefined,
) {
  if (!reviewed || canonicalJson(current.waitsByIssueId) !== canonicalJson(reviewed.waitsByIssueId)) return false;
  if (
    reviewed.version === 3 &&
    canonicalJson(current.nonLeafStatuses ?? []) !== canonicalJson(reviewed.nonLeafStatuses ?? [])
  ) return false;
  const reviewedLeaves = new Map(reviewed.materialLeaves.map((leaf) => [leaf.issueId, leaf]));
  return current.materialLeaves.every((leaf) => {
    const previous = reviewedLeaves.get(leaf.issueId);
    return previous != null && canonicalJson(previous) === canonicalJson(leaf);
  });
}

export function classifyTaskWatchdogSubtree(input: TaskWatchdogClassifierInput): TaskWatchdogClassifierResult {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issuesById.get(input.watchdog.issueId);
  if (!root || root.companyId !== input.watchdog.companyId) {
    return { state: "not_applicable", reason: "Watched issue is missing.", includedIssueIds: [] };
  }
  if (root.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
    return {
      state: "not_applicable",
      reason: "Task watchdog origin issues cannot themselves be watched.",
      includedIssueIds: [],
    };
  }

  const childrenByParentId = new Map<string, TaskWatchdogClassifierIssue[]>();
  for (const issue of input.issues) {
    if (issue.companyId !== input.watchdog.companyId || !issue.parentId) continue;
    const list = childrenByParentId.get(issue.parentId) ?? [];
    list.push(issue);
    childrenByParentId.set(issue.parentId, list);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.id.localeCompare(right.id));
  }

  const included: TaskWatchdogClassifierIssue[] = [];
  const visit = (issue: TaskWatchdogClassifierIssue) => {
    if (issue.originKind === TASK_WATCHDOG_ORIGIN_KIND) return;
    included.push(issue);
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  if (included.length === 0) {
    return { state: "not_applicable", reason: "Watched subtree has no non-watchdog issues.", includedIssueIds: [] };
  }

  const includedIds = included.map((issue) => issue.id);
  const includedIdSet = new Set(includedIds);
  const liveIssueIds = [
    ...pathIssueIds(input.activeRuns, input.watchdog.companyId),
    ...pathIssueIds(input.queuedWakeRequests, input.watchdog.companyId),
  ].filter((issueId) => includedIdSet.has(issueId));
  const uniqueLiveIssueIds = [...new Set(liveIssueIds)].sort();
  if (uniqueLiveIssueIds.length > 0) {
    return {
      state: "live",
      reason: "At least one issue in the watched subtree has a live run, queued wake, or scheduled retry.",
      includedIssueIds: includedIds,
      liveIssueIds: uniqueLiveIssueIds,
    };
  }

  // Pending-first-run guard: a watchdog evaluation triggered as part of issue
  // (or watchdog) creation can read its snapshot before the issue's own
  // assignment run/wake is committed/visible, making an actively-starting
  // subtree look idle. Suppress the stopped verdict for non-terminal issues
  // created within the first-run grace window that have never completed a run.
  const evaluatedAtMs = toEpochMs(input.evaluatedAt);
  const graceMs = input.firstRunGraceMs ?? 0;
  if (evaluatedAtMs != null && graceMs > 0) {
    const completedRunIssueIds = new Set(input.completedRunIssueIds ?? []);
    const pendingIssueIds = included
      .filter((issue) => {
        if (isTerminalIssueStatus(issue.status)) return false;
        if (completedRunIssueIds.has(issue.id)) return false;
        const createdAtMs = toEpochMs(issue.createdAt);
        if (createdAtMs == null) return false;
        return evaluatedAtMs - createdAtMs < graceMs;
      })
      .map((issue) => issue.id)
      .sort();
    if (pendingIssueIds.length > 0) {
      return {
        state: "pending_first_run",
        reason:
          "A watched issue was created within the first-run grace window and has not yet completed a run; deferring evaluation until its first assignment run/wake is observable.",
        includedIssueIds: includedIds,
        pendingIssueIds,
      };
    }
  }

  const includedChildrenByParentId = new Map<string, string[]>();
  for (const issue of included) {
    if (!issue.parentId || !includedIdSet.has(issue.parentId)) continue;
    const list = includedChildrenByParentId.get(issue.parentId) ?? [];
    list.push(issue.id);
    includedChildrenByParentId.set(issue.parentId, list);
  }
  const blockersByIssueId = new Map<string, string[]>();
  for (const relation of input.blockers ?? []) {
    if (relation.companyId !== input.watchdog.companyId) continue;
    if (!includedIdSet.has(relation.blockedIssueId)) continue;
    const list = blockersByIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation.blockerIssueId);
    blockersByIssueId.set(relation.blockedIssueId, list);
  }

  const nonTerminalIssues = included
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const waitsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, {
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
    }] as const)
    .filter(([, waits]) => waits.pendingInteractionIds.length > 0 || waits.pendingApprovalIds.length > 0));
  const pendingInteractionsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, (input.pendingInteractions ?? [])
      .filter((path) => path.companyId === input.watchdog.companyId && path.issueId === issue.id)
      .map((path) => ({ id: path.id ?? `${path.status}:${path.issueId}`, kind: path.kind ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id))] as const)
    .filter(([, waits]) => waits.length > 0));

  const leaves = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length === 0)
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
      updatedAt: issueUpdatedAtIso(issue),
      latestCommentAt: optionalIso(issue.latestCommentAt),
      latestDocumentAt: optionalIso(issue.latestDocumentAt),
      latestWorkProductAt: optionalIso(issue.latestWorkProductAt),
    }));
  const materialLeaves = leaves.map(materialLeaf);
  const nonLeafStatuses = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({ issueId: issue.id, status: issue.status }));
  const stopFingerprint = stableStopFingerprint({
    companyId: input.watchdog.companyId,
    watchedIssueId: input.watchdog.issueId,
    materialLeaves,
    waitsByIssueId,
    nonLeafStatuses,
  });
  const currentStopSnapshot: TaskWatchdogStopSnapshot = {
    version: 3,
    fingerprint: stopFingerprint,
    materialLeaves,
    waitsByIssueId,
    nonLeafStatuses,
  };

  if (
    input.watchdog.lastReviewedFingerprint === stopFingerprint ||
    isShrinkOfReviewedSnapshot(currentStopSnapshot, input.watchdog.lastReviewedStopSnapshot)
  ) {
    return {
      state: "already_reviewed",
      reason: "The current stopped subtree fingerprint was already reviewed by the watchdog.",
      includedIssueIds: includedIds,
      stopFingerprint,
      stoppedLeaves: leaves,
      stopSnapshot: currentStopSnapshot,
      pendingInteractionsByIssueId,
    };
  }

  return {
    state: "stopped",
    reason: "No issue in the watched subtree has a live execution path.",
    includedIssueIds: includedIds,
    stopFingerprint,
    stoppedLeaves: leaves,
    stopSnapshot: currentStopSnapshot,
    pendingInteractionsByIssueId,
  };
}

async function assertWatchedIssue(dbOrTx: any, companyId: string, issueId: string) {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function assertWatchdogAgentInvokable(dbOrTx: any, companyId: string, agentId: string) {
  const agent = await dbOrTx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows: Array<{
      id: string;
      companyId: string;
      name: string;
      reportsTo: string | null;
      status: string;
    }>) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) {
    throw notFound("Watchdog agent not found");
  }
  const invokability = await evaluateAgentInvokabilityFromDb(dbOrTx as Db, agent);
  if (!invokability.invokable) {
    throw conflict("Cannot assign watchdog to an agent that is not invokable", invokability);
  }
  return agent;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nested = parseObject(parsed._paperclipWakeContext);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(parsed.taskId) ??
    readNonEmptyString(nested.issueId) ??
    readNonEmptyString(nested.taskId);
}

function normalizeStopFingerprint(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed?.startsWith(TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX) ? trimmed : null;
}

function stopFingerprintFromText(value: string | null | undefined) {
  const match = value?.match(/task_watchdog_stop:[a-f0-9]+/i);
  return normalizeStopFingerprint(match?.[0] ?? null);
}

function reviewedFingerprintForWatchdogIssue(issue: Pick<IssueRow, "originFingerprint" | "description">) {
  return normalizeStopFingerprint(issue.originFingerprint) ?? stopFingerprintFromText(issue.description);
}

function taskWatchdogWakeIdempotencyKey(watchdogId: string, stopFingerprint: string, attempt: number) {
  return `task_watchdog:${watchdogId}:${stopFingerprint}:attempt:${attempt}`;
}

function buildStoppedFingerprintComment(input: {
  sourceIssue: Pick<IssueRow, "identifier" | "id">;
  stopFingerprint: string;
  stoppedLeaves: TaskWatchdogStoppedLeaf[];
  pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  resumed: boolean;
}) {
  const shortId = (id: string) => id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const leafLines = input.stoppedLeaves.slice(0, 12).map((leaf) => {
    const interactionKinds = new Map(
      (input.pendingInteractionsByIssueId[leaf.issueId] ?? []).map((wait) => [wait.id, wait.kind]),
    );
    const waits = [
      ...leaf.pendingInteractionIds.map((id) => `${interactionKinds.get(id) ?? "interaction"} ${shortId(id)}`),
      ...leaf.pendingApprovalIds.map((id) => `approval ${shortId(id)}`),
    ];
    return `- ${leaf.identifier ?? leaf.issueId}: ${leaf.status}${waits.length > 0 ? ` (pending ${waits.join(", ")})` : ""}`;
  });
  const more = input.stoppedLeaves.length > leafLines.length
    ? `\n- ...and ${input.stoppedLeaves.length - leafLines.length} more stopped leaves`
    : "";
  return [
    input.resumed ? "Task watchdog resumed for stopped subtree." : "Task watchdog started for stopped subtree.",
    "",
    `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
    `Stopped fingerprint: \`${input.stopFingerprint}\``,
    "",
    "Stopped leaves:",
    ...(leafLines.length > 0 ? leafLines : ["- No leaf issues found."]),
    more,
  ].filter((line) => line !== "").join("\n");
}

function stoppedFingerprintMetadata(input: {
  sourceIssueId: string;
  stopFingerprint: string;
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  resumed: boolean;
}) {
  const pendingWaitCount = Object.values(input.waitsByIssueId).reduce(
    (count, waits) => count + waits.pendingInteractionIds.length + waits.pendingApprovalIds.length,
    0,
  );
  return {
    version: 1 as const,
    sections: [
      {
        title: "Task Watchdog",
        rows: [
          { type: "text" as const, label: "Watched issue", text: input.sourceIssueId },
          { type: "text" as const, label: "Stopped fingerprint", text: input.stopFingerprint },
          { type: "text" as const, label: "Pending waits", text: String(pendingWaitCount) },
          { type: "text" as const, label: "Resume intent", text: input.resumed ? "true" : "false" },
        ],
      },
    ],
  };
}

function watchdogWakeContext(input: {
  watchdog: IssueWatchdogRow;
  watchdogIssue: IssueRow;
  sourceIssue: IssueRow;
  classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
  restorationAttempt: number;
}) {
  return {
    issueId: input.watchdogIssue.id,
    taskId: input.watchdogIssue.id,
    wakeReason: "task_watchdog_stopped_subtree",
    source: TASK_WATCHDOG_ORIGIN_KIND,
    taskWatchdog: {
      watchedIssueId: input.sourceIssue.id,
      watchedIssueIdentifier: input.sourceIssue.identifier,
      watchedIssueTitle: input.sourceIssue.title,
      stopFingerprint: input.classification.stopFingerprint,
      pendingInteractions: input.classification.pendingInteractionsByIssueId,
      pendingApprovals: Object.fromEntries(Object.entries(input.classification.stopSnapshot.waitsByIssueId)
        .filter(([, waits]) => waits.pendingApprovalIds.length > 0)
        .map(([issueId, waits]) => [issueId, waits.pendingApprovalIds])),
      restorationAttempt: input.restorationAttempt,
      restorationAttemptLimit: TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS,
      capabilities: {
        targetScope: {
          watchedIssueId: input.sourceIssue.id,
          watchedIssueIdentifier: input.sourceIssue.identifier,
          watchdogIssueId: input.watchdogIssue.id,
          includeNonWatchdogDescendants: true,
          excludedOriginKinds: [TASK_WATCHDOG_ORIGIN_KIND],
        },
        operations: [
          "comment_on_watched_subtree_issues",
          "transition_watched_subtree_issue_status",
          "reassign_watched_subtree_issues",
          "create_child_issues_under_non_watchdog_watched_subtree",
          "create_product_bug_followups_outside_watched_subtree",
          "resolve_eligible_request_confirmation_plan_interactions",
          "update_reusable_watchdog_issue",
        ],
        deniedOperations: [
          "create_visible_probe_issues_or_throwaway_tasks",
          "create_product_bug_followups_as_source_tree_children",
          "mutate_task_watchdog_descendants",
          "mutate_outside_watched_subtree",
          "resolve_board_only_or_security_sensitive_approvals",
          "create_nested_task_watchdogs",
        ],
      },
    },
    watchdogId: input.watchdog.id,
    watchedIssueId: input.sourceIssue.id,
    watchedIssueIdentifier: input.sourceIssue.identifier,
    stopFingerprint: input.classification.stopFingerprint,
    stoppedLeaves: input.classification.stoppedLeaves,
    customInstructions: input.watchdog.instructions,
    resumeIntent: true,
    followUpRequested: true,
  };
}

function isTerminalIssueStatus(status: string) {
  return TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES.includes(
    status as (typeof TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES)[number],
  );
}

function isWatchdogReviewDisposition(issue: Pick<
  IssueRow,
  "status" | "assigneeUserId" | "executionState" | "monitorNextCheckAt"
>, hasPendingReviewPath: boolean) {
  if (issue.status === "done" || issue.status === "blocked") return true;
  if (issue.status !== "in_review") return false;
  return Boolean(issue.assigneeUserId || issue.executionState || issue.monitorNextCheckAt || hasPendingReviewPath);
}

function isUniqueConstraintConflict(error: unknown, constraintName: string) {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  for (const candidate of queue) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
      message?: string;
    };
    if (typed.code === "23505") hasUniqueCode = true;
    if (typed.constraint === constraintName || typed.constraint_name === constraintName) hasConstraint = true;
    if (typed.message) messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(constraintName));
}

function isActiveTaskWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issues_active_task_watchdog_uq");
}

function isIssueWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issue_watchdogs_company_issue_uq");
}

async function updateIssueWatchdogRow(
  dbOrTx: any,
  existing: IssueWatchdogRow,
  input: IssueWatchdogUpsertInput,
  now: Date,
) {
  const [updated] = await dbOrTx
    .update(issueWatchdogs)
    .set({
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      updatedAt: now,
    })
    .where(eq(issueWatchdogs.id, existing.id))
    .returning();
  return updated;
}

export async function upsertIssueWatchdogForIssue(
  dbOrTx: any,
  companyId: string,
  issueId: string,
  input: IssueWatchdogUpsertInput,
): Promise<{ watchdog: IssueWatchdog; created: boolean }> {
  await assertWatchedIssue(dbOrTx, companyId, issueId);
  await assertWatchdogAgentInvokable(dbOrTx, companyId, input.agentId);

  const now = new Date();
  const existing = await dbOrTx
    .select()
    .from(issueWatchdogs)
    .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
    .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);

  if (existing) {
    const updated = await updateIssueWatchdogRow(dbOrTx, existing, input, now);
    return { watchdog: toIssueWatchdog(updated), created: false };
  }

  const insertResult: { row: IssueWatchdogRow; created: boolean } = await dbOrTx
    .insert(issueWatchdogs)
    .values({
      companyId,
      issueId,
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      createdByAgentId: input.actor?.agentId ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdByRunId: input.actor?.runId ?? null,
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows: IssueWatchdogRow[]) => ({ row: rows[0], created: true }))
    .catch(async (error: unknown) => {
      if (!isIssueWatchdogUniqueConflict(error)) throw error;
      const winner = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
      if (!winner) throw error;
      const updated = await updateIssueWatchdogRow(dbOrTx, winner, input, now);
      return { row: updated, created: false };
    });
  return { watchdog: toIssueWatchdog(insertResult.row), created: insertResult.created };
}

export function taskWatchdogService(db: Db, deps: TaskWatchdogServiceDeps = {}) {
  const issuesSvc = issueService(db);

  async function loadWatchdogSubtreeIssues(companyId: string, watchedIssueId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE watched_issues AS (
        SELECT
          id,
          company_id,
          identifier,
          title,
          status,
          parent_id,
          assignee_agent_id,
          assignee_user_id,
          origin_kind,
          updated_at,
          created_at,
          0 AS depth
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${watchedIssueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT
          child.id,
          child.company_id,
          child.identifier,
          child.title,
          child.status,
          child.parent_id,
          child.assignee_agent_id,
          child.assignee_user_id,
          child.origin_kind,
          child.updated_at,
          child.created_at,
          watched_issues.depth + 1
        FROM issues child
        JOIN watched_issues ON child.parent_id = watched_issues.id
        WHERE child.company_id = ${companyId}
          AND child.hidden_at IS NULL
          AND child.harness_kind IS NULL
          AND child.origin_kind <> ${TASK_WATCHDOG_ORIGIN_KIND}
          AND watched_issues.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT
        id,
        company_id AS "companyId",
        identifier,
        title,
        status,
        parent_id AS "parentId",
        assignee_agent_id AS "assigneeAgentId",
        assignee_user_id AS "assigneeUserId",
        origin_kind AS "originKind",
        updated_at AS "updatedAt",
        created_at AS "createdAt"
      FROM watched_issues
    `);

    return (Array.isArray(rows) ? rows : []) as TaskWatchdogClassifierIssue[];
  }

  async function collectClassifierInput(companyId: string, watchdog: IssueWatchdogRow) {
    const issueRows = await loadWatchdogSubtreeIssues(companyId, watchdog.issueId);
    const subtreeIssueIds = issueRows.map((issue) => issue.id);
    if (subtreeIssueIds.length === 0) {
      return {
        watchdog: summarizeIssueWatchdog(watchdog),
        issues: [],
        activeRuns: [],
        queuedWakeRequests: [],
        blockers: [],
        pendingInteractions: [],
        pendingApprovals: [],
        evaluatedAt: new Date(),
        firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
        completedRunIssueIds: [],
      } satisfies TaskWatchdogClassifierInput;
    }

    const [
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      blockerRows,
      interactionRows,
      approvalRows,
      commentActivityRows,
      documentActivityRows,
      workProductActivityRows,
    ] = await Promise.all([
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, subtreeIssueIds),
          visibleIssueCondition(),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        )),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          or(
            inArray(sql`${agentWakeupRequests.payload}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->>'taskId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId'`, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, subtreeIssueIds),
        )),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.issueId, subtreeIssueIds),
          eq(issueThreadInteractions.status, "pending"),
        )),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          id: approvals.id,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          inArray(issueApprovals.issueId, subtreeIssueIds),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )),
      db
        .select({
          issueId: issueComments.issueId,
          latestAt: sql<Date | null>`MAX(${issueComments.updatedAt})`,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, subtreeIssueIds),
          isNull(issueComments.deletedAt),
        ))
        .groupBy(issueComments.issueId),
      db
        .select({
          issueId: issueDocuments.issueId,
          latestAt: sql<Date | null>`MAX(${issueDocuments.updatedAt})`,
        })
        .from(issueDocuments)
        .where(and(
          eq(issueDocuments.companyId, companyId),
          inArray(issueDocuments.issueId, subtreeIssueIds),
        ))
        .groupBy(issueDocuments.issueId),
      db
        .select({
          issueId: issueWorkProducts.issueId,
          latestAt: sql<Date | null>`MAX(${issueWorkProducts.updatedAt})`,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.issueId, subtreeIssueIds),
        ))
        .groupBy(issueWorkProducts.issueId),
    ]);
    const latestCommentByIssueId = new Map(commentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestDocumentByIssueId = new Map(documentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestWorkProductByIssueId = new Map(workProductActivityRows.map((row) => [row.issueId, row.latestAt]));

    const evaluatedAt = new Date();
    const evaluatedAtMs = evaluatedAt.getTime();
    // Only the issues created within the first-run grace window can be racing
    // their own assignment run; scope the (potentially expensive) terminal-run
    // lookup to those few issues so the common path stays a no-op.
    const freshIssueIds = issueRows
      .filter((row) => {
        if (isTerminalIssueStatus(row.status)) return false;
        const createdAtMs = toEpochMs(row.createdAt);
        return createdAtMs != null && evaluatedAtMs - createdAtMs < TASK_WATCHDOG_FIRST_RUN_GRACE_MS;
      })
      .map((row) => row.id);
    const completedRunIssueIds = await collectCompletedRunIssueIds(companyId, freshIssueIds);

    return {
      watchdog: {
        ...summarizeIssueWatchdog(watchdog),
        lastReviewedStopSnapshot: parseStopSnapshot(watchdog.lastReviewedStopSnapshot),
      },
      issues: issueRows.map((issue) => ({
        ...issue,
        latestCommentAt: latestCommentByIssueId.get(issue.id) ?? null,
        latestDocumentAt: latestDocumentByIssueId.get(issue.id) ?? null,
        latestWorkProductAt: latestWorkProductByIssueId.get(issue.id) ?? null,
      })),
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      blockers: blockerRows,
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      evaluatedAt,
      firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
      completedRunIssueIds,
    } satisfies TaskWatchdogClassifierInput;
  }

  // Returns the subset of `issueIds` that already have at least one run in a
  // terminal status. Such issues have demonstrably executed, so a stopped
  // subtree is genuine and must not be masked by the pending-first-run guard.
  async function collectCompletedRunIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const candidates = new Set(issueIds);
    const [contextRuns, executionRuns] = await Promise.all([
      db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, issueIds),
          ),
        )),
      db
        .select({ issueId: issues.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIds),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
        )),
    ]);
    const completed = new Set<string>();
    for (const row of contextRuns) {
      const issueId = issueIdFromRunContext(row.contextSnapshot);
      if (issueId && candidates.has(issueId)) completed.add(issueId);
    }
    for (const row of executionRuns) {
      completed.add(row.issueId);
    }
    return [...completed];
  }

  async function findTaskWatchdogIssue(companyId: string, watchedIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, TASK_WATCHDOG_ORIGIN_KIND),
        eq(issues.originId, watchedIssueId),
        visibleIssueCondition(),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasLivePathForIssue(companyId: string, issueId: string) {
    const [run, issueRun, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
          sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
            OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.id, issueId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          sql`(${agentWakeupRequests.payload}->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->>'taskId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || issueRun || wake);
  }

  async function sameFingerprintWatchdogReviewIsStillOpen(
    watchdogIssue: IssueRow | null,
    stopFingerprint: string,
  ) {
    if (!watchdogIssue) return false;
    if (watchdogIssue.originFingerprint !== stopFingerprint) return false;
    if (isTerminalIssueStatus(watchdogIssue.status) || watchdogIssue.status === "backlog") return false;
    if (watchdogIssue.status === "in_review") {
      const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
      return isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
    }
    return true;
  }

  async function watchdogIssueNeedsFreshWake(watchdogIssue: IssueRow) {
    if (watchdogIssue.status !== "in_review") return false;
    const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
    return !isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
  }

  async function watchdogIssueHasPendingReviewPath(companyId: string, issueId: string) {
    const [interaction, approval] = await Promise.all([
      db
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(interaction || approval);
  }

  async function markTerminalWatchdogIssueReviewed(watchdog: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    if (!watchdog.watchdogIssueId || !watchdog.lastObservedFingerprint) return watchdog;
    const watchdogIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.watchdogIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!watchdogIssue) return watchdog;
    const hasPendingReviewPath = watchdogIssue.status === "in_review"
      ? await watchdogIssueHasPendingReviewPath(watchdog.companyId, watchdogIssue.id)
      : false;
    if (!isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath)) return watchdog;
    const reviewedFingerprint = reviewedFingerprintForWatchdogIssue(watchdogIssue);
    if (!reviewedFingerprint) return watchdog;
    const observedSnapshot = parseStopSnapshot(watchdog.lastObservedStopSnapshot);
    const reviewedStopSnapshot = observedSnapshot?.fingerprint === reviewedFingerprint
      ? observedSnapshot
      : null;
    if (watchdog.restorationFingerprint === reviewedFingerprint && watchdog.restorationVerificationPending) {
      const [updated] = await db
        .update(issueWatchdogs)
        .set({ restorationVerificationPending: false, lastCompletedAt: new Date(), updatedAt: new Date() })
        .where(eq(issueWatchdogs.id, watchdog.id))
        .returning();
      return updated ?? watchdog;
    }
    if (
      watchdog.lastReviewedFingerprint === reviewedFingerprint &&
      canonicalJson(parseStopSnapshot(watchdog.lastReviewedStopSnapshot)) === canonicalJson(reviewedStopSnapshot)
    ) return watchdog;
    const [updated] = await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: reviewedFingerprint,
        lastReviewedStopSnapshot: reviewedStopSnapshot,
        restorationFingerprint: null,
        restorationVerificationPending: false,
        restorationAttemptCount: 0,
        restorationAttempts: [],
        restorationEscalatedAt: null,
        lastCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issueWatchdogs.id, watchdog.id))
      .returning();
    await logActivity(db, {
      companyId: watchdog.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_fingerprint_reviewed",
      entityType: "issue",
      entityId: watchdog.issueId,
      details: {
        source: "task_watchdogs.review_disposition",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        reviewedFingerprint,
        lastObservedFingerprint: watchdog.lastObservedFingerprint,
        reviewedStopSnapshot,
        watchdogIssueStatus: watchdogIssue.status,
      },
    });
    return updated ?? watchdog;
  }

  async function ensureReusableWatchdogIssue(input: {
    watchdog: IssueWatchdogRow;
    sourceIssue: IssueRow;
    classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
    runId?: string | null;
  }) {
    const existing = input.watchdog.watchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, input.watchdog.companyId),
          eq(issues.id, input.watchdog.watchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    const fallback = existing ?? await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);

    if (fallback) {
      const shouldReopen = isTerminalIssueStatus(fallback.status) ||
        fallback.status === "backlog" ||
        await watchdogIssueNeedsFreshWake(fallback);
      const watchdogIssue = shouldReopen
        ? await issuesSvc.update(fallback.id, {
          status: "todo",
          assigneeAgentId: input.watchdog.watchdogAgentId,
          parentId: input.sourceIssue.id,
          projectId: input.sourceIssue.projectId,
          goalId: input.sourceIssue.goalId,
          billingCode: input.sourceIssue.billingCode,
          originFingerprint: input.classification.stopFingerprint,
        }) ?? fallback
        : fallback;
      if (!shouldReopen && watchdogIssue.originFingerprint !== input.classification.stopFingerprint) {
        await db
          .update(issues)
          .set({ originFingerprint: input.classification.stopFingerprint, updatedAt: new Date() })
          .where(and(eq(issues.companyId, input.watchdog.companyId), eq(issues.id, watchdogIssue.id)));
        watchdogIssue.originFingerprint = input.classification.stopFingerprint;
      }
      await issuesSvc.addComment(
        watchdogIssue.id,
        buildStoppedFingerprintComment({
          sourceIssue: input.sourceIssue,
          stopFingerprint: input.classification.stopFingerprint,
          stoppedLeaves: input.classification.stoppedLeaves,
          pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
          resumed: true,
        }),
        { runId: input.runId ?? null },
        {
          authorType: "system",
          metadata: stoppedFingerprintMetadata({
            sourceIssueId: input.sourceIssue.id,
            stopFingerprint: input.classification.stopFingerprint,
            waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
            resumed: true,
          }),
        },
      );
      return watchdogIssue;
    }

    const created = await issuesSvc.create(input.sourceIssue.companyId, {
        title: `Watchdog review for ${input.sourceIssue.identifier ?? input.sourceIssue.title}`,
        description: [
          "Task watchdog review issue.",
          "",
          `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
          `Stopped fingerprint: ${input.classification.stopFingerprint}`,
          "",
          "The watchdog agent should verify the stopped subtree and either confirm the disposition or restore a valid live path.",
        ].join("\n"),
        status: "todo",
        priority: input.sourceIssue.priority,
        parentId: input.sourceIssue.id,
        projectId: input.sourceIssue.projectId,
        goalId: input.sourceIssue.goalId,
        assigneeAgentId: input.watchdog.watchdogAgentId,
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        originId: input.sourceIssue.id,
        originFingerprint: input.classification.stopFingerprint,
        billingCode: input.sourceIssue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.sourceIssue.id,
      })
      .catch(async (error: unknown) => {
        if (!isActiveTaskWatchdogUniqueConflict(error)) throw error;
        const winner = await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);
        if (!winner) throw error;
        return winner;
      });
    await issuesSvc.addComment(
      created.id,
      buildStoppedFingerprintComment({
        sourceIssue: input.sourceIssue,
        stopFingerprint: input.classification.stopFingerprint,
        stoppedLeaves: input.classification.stoppedLeaves,
        pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
        resumed: false,
      }),
      { runId: input.runId ?? null },
      {
        authorType: "system",
        metadata: stoppedFingerprintMetadata({
          sourceIssueId: input.sourceIssue.id,
          stopFingerprint: input.classification.stopFingerprint,
          waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
          resumed: false,
        }),
      },
    );
    return created;
  }

  async function evaluateWatchdog(row: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    const watchdog = await markTerminalWatchdogIssueReviewed(row, opts);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.issueId), visibleIssueCondition()))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue || sourceIssue.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
      return { state: "skipped" as const, reason: "watched_issue_not_applicable" };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state !== "stopped") {
      return { state: classification.state, reason: classification.reason, classification };
    }

    const retryingRestoration = watchdog.restorationFingerprint === classification.stopFingerprint;
    if (retryingRestoration && watchdog.restorationAttemptCount >= TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS) {
      if (watchdog.restorationEscalatedAt) {
        return { state: "restoration_escalated" as const, classification, watchdogIssueId: watchdog.watchdogIssueId };
      }
      const escalation = await db.transaction(async (tx) => {
        const transactionDb = tx as unknown as Db;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${watchdog.id}, 0))`);
        await tx.execute(sql`select id from issue_watchdogs where id = ${watchdog.id} for update`);
        const current = await tx
          .select()
          .from(issueWatchdogs)
          .where(and(
            eq(issueWatchdogs.id, watchdog.id),
            eq(issueWatchdogs.status, "active"),
          ))
          .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
        if (!current) return "stale" as const;
        if (current.restorationEscalatedAt) return "already_escalated" as const;
        if (
          current.restorationFingerprint !== classification.stopFingerprint ||
          current.restorationAttemptCount < TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS
        ) {
          return "stale" as const;
        }

        const escalatedAt = new Date();
        if (current.watchdogIssueId) {
          const attemptHistory = current.restorationAttempts
            .map((attempt) => `- Attempt ${attempt.attempt}: run \`${attempt.runId ?? "unknown"}\` at ${attempt.completedAt}`)
            .join("\n");
          await tx
            .update(issues)
            .set({
              status: "in_review",
              assigneeAgentId: null,
              assigneeUserId: sourceIssue.responsibleUserId ?? sourceIssue.createdByUserId ?? current.createdByUserId,
              updatedAt: escalatedAt,
            })
            .where(and(
              eq(issues.companyId, current.companyId),
              eq(issues.id, current.watchdogIssueId),
            ));
          await issueService(transactionDb).addComment(
            current.watchdogIssueId,
            `Task watchdog restoration attempts exhausted; human review is required.\n\nStopped fingerprint: \`${classification.stopFingerprint}\`\nAttempts: ${current.restorationAttemptCount}/${TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS}\n\nAttempt history:\n${attemptHistory}`,
            { runId: opts.runId ?? null },
            { authorType: "system" },
            tx,
          );
        }
        await tx
          .update(issueWatchdogs)
          .set({ restorationEscalatedAt: escalatedAt, updatedAt: escalatedAt })
          .where(eq(issueWatchdogs.id, current.id));
        await logActivity(transactionDb, {
          companyId: current.companyId,
          actorType: "system",
          actorId: "system",
          agentId: current.watchdogAgentId,
          runId: opts.runId ?? null,
          action: "issue.task_watchdog_restoration_escalated",
          entityType: "issue",
          entityId: current.issueId,
          details: {
            watchdogId: current.id,
            watchdogIssueId: current.watchdogIssueId,
            stopFingerprint: classification.stopFingerprint,
            attempts: current.restorationAttempts,
          },
        });
        return "escalated" as const;
      });
      if (escalation === "stale") {
        return { state: "skipped" as const, reason: "restoration_state_changed", classification };
      }
      return { state: "restoration_escalated" as const, classification, watchdogIssueId: watchdog.watchdogIssueId };
    }

    const existingWatchdogIssueId = watchdog.watchdogIssueId ?? (await findTaskWatchdogIssue(
      watchdog.companyId,
      sourceIssue.id,
    ))?.id ?? null;
    if (existingWatchdogIssueId && await hasLivePathForIssue(watchdog.companyId, existingWatchdogIssueId)) {
      await db
        .update(issueWatchdogs)
        .set({
          watchdogIssueId: existingWatchdogIssueId,
          lastObservedFingerprint: classification.stopFingerprint,
          lastObservedStopSnapshot: classification.stopSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, watchdog.id));
      return { state: "watchdog_live" as const, classification, watchdogIssueId: existingWatchdogIssueId };
    }
    const existingWatchdogIssue = existingWatchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, watchdog.companyId),
          eq(issues.id, existingWatchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (await sameFingerprintWatchdogReviewIsStillOpen(existingWatchdogIssue, classification.stopFingerprint)) {
      if (
        watchdog.watchdogIssueId !== existingWatchdogIssue!.id ||
        watchdog.lastObservedFingerprint !== classification.stopFingerprint ||
        canonicalJson(parseStopSnapshot(watchdog.lastObservedStopSnapshot)) !== canonicalJson(classification.stopSnapshot)
      ) {
        await db
          .update(issueWatchdogs)
          .set({
            watchdogIssueId: existingWatchdogIssue!.id,
            lastObservedFingerprint: classification.stopFingerprint,
            lastObservedStopSnapshot: classification.stopSnapshot,
            updatedAt: new Date(),
          })
          .where(eq(issueWatchdogs.id, watchdog.id));
      }
      return {
        state: "watchdog_review_open" as const,
        classification,
        watchdogIssueId: existingWatchdogIssue!.id,
      };
    }

    const watchdogIssue = await ensureReusableWatchdogIssue({
      watchdog,
      sourceIssue,
      classification,
      runId: opts.runId ?? null,
    });
    const now = new Date();
    await db
      .update(issueWatchdogs)
      .set({
        watchdogIssueId: watchdogIssue.id,
        lastObservedFingerprint: classification.stopFingerprint,
        lastObservedStopSnapshot: classification.stopSnapshot,
        lastTriggeredAt: now,
        triggerCount: sql`${issueWatchdogs.triggerCount} + 1`,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, watchdog.id));

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_triggered",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "task_watchdogs.evaluate",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        stopFingerprint: classification.stopFingerprint,
        stopSnapshot: classification.stopSnapshot,
        stoppedLeaves: classification.stoppedLeaves,
      },
    });

    const context = watchdogWakeContext({
      watchdog,
      watchdogIssue,
      sourceIssue,
      classification,
      restorationAttempt: retryingRestoration ? watchdog.restorationAttemptCount + 1 : 1,
    });
    const wake = deps.enqueueWakeup
      ? await deps.enqueueWakeup(watchdog.watchdogAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "task_watchdog_stopped_subtree",
        payload: context,
        contextSnapshot: context,
        idempotencyKey: taskWatchdogWakeIdempotencyKey(watchdog.id, classification.stopFingerprint, retryingRestoration ? watchdog.restorationAttemptCount + 1 : 1),
        requestedByActorType: "system",
        requestedByActorId: null,
      })
      : null;

    return {
      state: "triggered" as const,
      classification,
      watchdogIssueId: watchdogIssue.id,
      wakeupRunId: wake?.id ?? null,
    };
  }

  async function listActiveWatchdogsForCompany(companyId?: string | null) {
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.status, "active"),
        ...(companyId ? [eq(issueWatchdogs.companyId, companyId)] : []),
      ));
  }

  async function activeWatchdogsForIssueAndAncestors(companyId: string, issueId: string) {
    const ancestorRows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND parent.hidden_at IS NULL
          AND parent.harness_kind IS NULL
          AND ancestors.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT id FROM ancestors
    `);
    const ancestorIds = (Array.isArray(ancestorRows) ? ancestorRows : [])
      .map((row) => typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : null)
      .filter((id): id is string => typeof id === "string");
    if (ancestorIds.length === 0) return [];
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.status, "active"),
        inArray(issueWatchdogs.issueId, ancestorIds),
      ));
  }

  async function applyRecoveryBatch(
    scope: {
      kind: "watchdog";
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      watchdogIssueId: string | null;
      stopFingerprint: string | null;
    },
    input: TaskWatchdogRecoveryBatch,
    actor: { agentId: string; runId: string },
  ) {
    if (!scope.stopFingerprint || input.stopFingerprint !== scope.stopFingerprint) {
      throw conflict("Task-watchdog recovery batch fingerprint does not match the persisted run context.");
    }
    const stopFingerprint = scope.stopFingerprint;

    const batchResult = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.watchdogId}, 0))`);
      await tx.execute(sql`select id from issue_watchdogs where id = ${scope.watchdogId} for update`);
      const watchdog = await tx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.id, scope.watchdogId),
          eq(issueWatchdogs.companyId, scope.companyId),
          eq(issueWatchdogs.issueId, scope.watchedIssueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
      if (!watchdog) throw conflict("Task-watchdog run context is not backed by an active persisted watchdog.");
      if (watchdog.restorationAttempts.some((attempt) => attempt.runId === actor.runId)) {
        throw conflict("Task-watchdog recovery batch is single-shot per run.");
      }

      await tx.execute(sql`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM issues WHERE company_id = ${scope.companyId} AND id = ${scope.watchedIssueId}
          UNION ALL
          SELECT child.id
          FROM issues child
          JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.company_id = ${scope.companyId}
            AND child.origin_kind IS DISTINCT FROM ${TASK_WATCHDOG_ORIGIN_KIND}
        )
        SELECT target.id FROM issues target JOIN subtree ON subtree.id = target.id FOR UPDATE OF target
      `);

      const revalidated = await taskWatchdogService(transactionDb).revalidateMutationScope(scope);
      if (!revalidated.allowed) throw conflict(revalidated.reason);

      const results: Array<Record<string, unknown>> = [];
      const resumeTargets: Array<{
        issueId: string;
        agentId: string;
        commentId: string | null;
        reopenedFrom: string;
        resumeIntent: boolean;
      }> = [];
      const txIssues = issueService(transactionDb);
      for (const mutation of input.mutations) {
        const target = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            parentId: issues.parentId,
            status: issues.status,
          })
          .from(issues)
          .where(and(eq(issues.id, mutation.issueId), eq(issues.companyId, scope.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!target) throw notFound("Issue not found");
        const allowed = await taskWatchdogScopeAllowsIssueMutation(transactionDb, scope, target, { allowWatchdogIssue: false });
        if (allowed.kind === "invalid") throw conflict(allowed.detail);

        if (mutation.type === "add_comment") {
          const comment = await txIssues.addComment(
            mutation.issueId,
            mutation.body,
            { agentId: actor.agentId, runId: actor.runId },
            { authorType: "agent" },
            tx,
          );
          results.push({ type: mutation.type, issueId: mutation.issueId, commentId: comment.id });
        } else {
          const { comment, reopen, resume, ...requestedUpdate } = mutation.update;
          const lifecycleIntent = resume === true ? "resume" : reopen === true ? "reopen" : null;
          if (lifecycleIntent === "resume" && !comment?.trim()) {
            throw conflict("Task-watchdog resume mutations require an audit comment.");
          }
          if (lifecycleIntent === "reopen" && target.status === "cancelled") {
            throw conflict("Cancelled issues require explicit resume intent, not reopen intent.");
          }
          if (lifecycleIntent && requestedUpdate.status !== undefined && requestedUpdate.status !== "todo") {
            throw conflict("Task-watchdog reopen and resume mutations must move the issue to todo.");
          }
          const update = lifecycleIntent
            ? { ...requestedUpdate, status: "todo" as const }
            : requestedUpdate;
          const updated = await txIssues.update(mutation.issueId, {
            ...update,
            actorAgentId: actor.agentId,
          }, tx);
          if (!updated) throw notFound("Issue not found");
          if (lifecycleIntent && target.status === "blocked") {
            const readiness = await txIssues.getDependencyReadiness(mutation.issueId);
            if (readiness.unresolvedBlockerCount > 0) {
              throw conflict("Task-watchdog recovery cannot resume a blocked issue while unresolved blockers remain.");
            }
          }
          let commentId: string | null = null;
          if (comment) {
            const addedComment = await txIssues.addComment(
              mutation.issueId,
              comment,
              { agentId: actor.agentId, runId: actor.runId },
              { authorType: "agent" },
              tx,
            );
            commentId = addedComment.id;
          }
          if (lifecycleIntent && updated.status === "todo" && updated.assigneeAgentId) {
            resumeTargets.push({
              issueId: updated.id,
              agentId: updated.assigneeAgentId,
              commentId,
              reopenedFrom: target.status,
              resumeIntent: lifecycleIntent === "resume",
            });
          }
          results.push({
            type: mutation.type,
            issueId: mutation.issueId,
            status: updated.status,
            ...(lifecycleIntent ? { lifecycleIntent } : {}),
          });
        }

        await logActivity(transactionDb, {
          companyId: scope.companyId,
          actorType: "agent",
          actorId: actor.agentId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.task_watchdog_recovery_mutation",
          entityType: "issue",
          entityId: mutation.issueId,
          details: {
            watchdogId: scope.watchdogId,
            sourceIssueId: scope.watchedIssueId,
            watchdogIssueId: scope.watchdogIssueId,
            stopFingerprint: scope.stopFingerprint,
            mutation,
          },
        });
      }

      const attempt = watchdog.restorationFingerprint === stopFingerprint
        ? watchdog.restorationAttemptCount + 1
        : 1;
      if (attempt > TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS) {
        throw conflict("Task-watchdog restoration attempt limit has been reached; human review is required.");
      }
      const completedAt = new Date();
      const attemptRecord = {
        attempt,
        fingerprint: stopFingerprint,
        runId: actor.runId,
        mutations: input.mutations,
        completedAt: completedAt.toISOString(),
      };
      await tx
        .update(issueWatchdogs)
        .set({
          restorationFingerprint: stopFingerprint,
          restorationVerificationPending: true,
          restorationAttemptCount: attempt,
          restorationAttempts: watchdog.restorationFingerprint === stopFingerprint
            ? [...watchdog.restorationAttempts, attemptRecord]
            : [attemptRecord],
          restorationEscalatedAt: null,
          lastReviewedFingerprint: null,
          lastCompletedAt: completedAt,
          updatedByAgentId: actor.agentId,
          updatedByRunId: actor.runId,
          updatedAt: completedAt,
        })
        .where(eq(issueWatchdogs.id, scope.watchdogId));

      return { attempt, attemptLimit: TASK_WATCHDOG_MAX_RESTORATION_ATTEMPTS, results, resumeTargets };
    });

    const { resumeTargets, ...result } = batchResult;
    for (const target of resumeTargets) {
      await deps.enqueueWakeup?.(target.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: target.commentId ? "issue_reopened_via_comment" : "issue_status_changed",
        payload: {
          issueId: target.issueId,
          ...(target.commentId ? { commentId: target.commentId } : {}),
          mutation: target.commentId ? "comment" : "update",
          reopenedFrom: target.reopenedFrom,
          ...(target.resumeIntent ? { resumeIntent: true, followUpRequested: true } : {}),
        },
        idempotencyKey: `task-watchdog-recovery:${scope.watchdogId}:${actor.runId}:${target.issueId}`,
        requestedByActorType: "agent",
        requestedByActorId: actor.agentId,
        contextSnapshot: {
          issueId: target.issueId,
          taskId: target.issueId,
          ...(target.commentId ? { commentId: target.commentId, wakeCommentId: target.commentId } : {}),
          source: "task_watchdog.recovery_batch",
          wakeReason: target.commentId ? "issue_reopened_via_comment" : "issue_status_changed",
          reopenedFrom: target.reopenedFrom,
          ...(target.resumeIntent
            ? { resumeIntent: true, followUpRequested: true, resumeRequiresNormalModel: true }
            : {}),
        },
      });
    }
    return result;
  }

  async function revalidateMutationScope(scope: {
    kind: "watchdog";
    watchdogId: string;
    companyId: string;
    watchedIssueId: string;
    stopFingerprint: string | null;
  }) {
    if (!scope.stopFingerprint) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is missing the stopped fingerprint required for mutation revalidation.",
      };
    }

    const watchdog = await db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.id, scope.watchdogId),
        eq(issueWatchdogs.companyId, scope.companyId),
        eq(issueWatchdogs.issueId, scope.watchedIssueId),
        eq(issueWatchdogs.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!watchdog) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is not backed by an active persisted watchdog.",
      };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state === "stopped" && classification.stopFingerprint === scope.stopFingerprint) {
      return { allowed: true as const, classification };
    }

    return {
      allowed: false as const,
      reason: classification.state === "stopped"
        ? "Task-watchdog review is stale because the watched subtree stop fingerprint changed; refresh the source state before mutating it."
        : "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
      classification,
    };
  }

  return {
    getActiveForIssue: async (companyId: string, issueId: string): Promise<IssueWatchdog | null> => {
      const row = await db
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          eq(issueWatchdogs.issueId, issueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWatchdog(row) : null;
    },

    listActiveSummariesForIssues: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: any = db,
    ): Promise<Map<string, IssueWatchdogSummary>> => {
      if (issueIds.length === 0) return new Map();
      const rows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, [...new Set(issueIds)]),
          eq(issueWatchdogs.status, "active"),
        ));
      return new Map(rows.map((row: IssueWatchdogRow) => [row.issueId, summarizeIssueWatchdog(row)]));
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
      input: IssueWatchdogUpsertInput,
    ): Promise<{ watchdog: IssueWatchdog; created: boolean }> => {
      return upsertIssueWatchdogForIssue(db, companyId, issueId, input);
    },

    disableForIssue: async (
      companyId: string,
      issueId: string,
      actor: ActorFields = {},
    ): Promise<IssueWatchdog | null> => {
      await assertWatchedIssue(db, companyId, issueId);
      const existing = await db
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status === "disabled") return null;
      const [updated] = await db
        .update(issueWatchdogs)
        .set({
          status: "disabled",
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedByRunId: actor.runId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, existing.id))
        .returning();
      return toIssueWatchdog(updated);
    },

    reconcileTaskWatchdogs: async (opts: {
      companyId?: string | null;
      runId?: string | null;
      issueCreatedAtGte?: Date | null;
    } = {}) => {
      let rows = await listActiveWatchdogsForCompany(opts.companyId ?? null);
      if (opts.issueCreatedAtGte) {
        const watchdogIssueIds = [...new Set(rows.map((row) => row.issueId))];
        const eligibleIssueIds = new Set(
          watchdogIssueIds.length === 0
            ? []
            : (await db
                .select({ id: issues.id })
                .from(issues)
                .where(and(
                  inArray(issues.id, watchdogIssueIds),
                  gte(issues.createdAt, opts.issueCreatedAtGte),
                )))
                .map((issue) => issue.id),
        );
        rows = rows.filter((row) => eligibleIssueIds.has(row.issueId));
      }
      const result = {
        checked: 0,
        triggered: 0,
        live: 0,
        pendingFirstRun: 0,
        alreadyReviewed: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (
          evaluated.state === "live" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "watchdog_review_open"
        ) {
          result.live += 1;
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "already_reviewed") {
          result.alreadyReviewed += 1;
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    reconcileForIssueAndAncestors: async (
      companyId: string,
      issueId: string,
      opts: { runId?: string | null } = {},
    ) => {
      const rows = await activeWatchdogsForIssueAndAncestors(companyId, issueId);
      const result = {
        checked: 0,
        triggered: 0,
        pendingFirstRun: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (
          evaluated.state === "watchdog_review_open" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "live"
        ) {
          // Existing review work is already open for this stopped state.
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    applyRecoveryBatch,
    revalidateMutationScope,
  };
}
