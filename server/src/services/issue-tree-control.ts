import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  ISSUE_STATUSES,
  type IssueStatus,
  type IssueTreeControlMode,
  type IssueTreeControlPreview,
  type IssueTreeHold,
  type IssueTreeHoldMember,
  type IssueTreeHoldReleasePolicy,
  type IssueTreePreviewAgent,
  type IssueTreePreviewIssue,
  type IssueTreePreviewRun,
  type IssueTreePreviewWarning,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type IssueRow = typeof issues.$inferSelect;
type HoldRow = typeof issueTreeHolds.$inferSelect;
type HoldMemberRow = typeof issueTreeHoldMembers.$inferSelect;
export type ActiveIssueTreePauseHoldGate = {
  holdId: string;
  rootIssueId: string;
  issueId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: IssueTreeHoldReleasePolicy | null;
};
export type ActiveIssueTreeCancelHoldGate = Omit<ActiveIssueTreePauseHoldGate, "mode"> & {
  mode: "cancel";
};
type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type TreeIssue = IssueRow & { depth: number };
type ActiveRunRow = {
  id: string;
  issueId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
type ActiveCancelSnapshot = {
  holdIds: string[];
  member: IssueTreeHoldMember | null;
};
type TreeStatusUpdateResult = {
  updatedIssueIds: string[];
  updatedIssues: Array<{
    id: string;
    status: IssueStatus;
    assigneeAgentId: string | null;
  }>;
};
type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: IssueTreeHold | null;
};
type CreateHoldResult = {
  hold: IssueTreeHold;
  preview: IssueTreeControlPreview;
  resumedPauseHoldIds?: string[];
  statusUpdate?: TreeStatusUpdateResult | RestoreTreeStatusResult;
};

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const DEFAULT_RELEASE_POLICY: IssueTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
export const ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_commented",
  "issue_reopened_via_comment",
] as const);
const ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  issue_commented: new Set(["issue.comment"]),
  issue_reopened_via_comment: new Set(["issue.comment.reopen"]),
};

type VerifiedInteractionActor = {
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
};

function readNonEmptyStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readInteractionWakeCommentId(record: unknown) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>).wakeCommentIds;
  if (Array.isArray(value)) {
    const latest = value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .at(-1);
    if (latest) return latest.trim();
  }
  return readNonEmptyStringFromRecord(record, "wakeCommentId") ?? readNonEmptyStringFromRecord(record, "commentId");
}

function hasVerifiedInteractionSource(wakeReason: string, contextSnapshot: Record<string, unknown>) {
  const source = readNonEmptyStringFromRecord(contextSnapshot, "source");
  if (!source) return false;
  return ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES[wakeReason]?.has(source) ?? false;
}

function actorMatchesComment(
  actor: VerifiedInteractionActor,
  comment: { authorAgentId: string | null; authorUserId: string | null },
) {
  if (!actor.requestedByActorType) return false;
  if (actor.requestedByActorType === "system") return true;
  if (!actor.requestedByActorId) return false;
  if (actor.requestedByActorType === "agent") return comment.authorAgentId === actor.requestedByActorId;
  if (actor.requestedByActorType === "user") return comment.authorUserId === actor.requestedByActorId;
  return false;
}

async function hasVerifiedInteractionWakeRequest(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
    issueId: string;
    commentId: string;
    comment: { authorAgentId: string | null; authorUserId: string | null };
  },
) {
  if (!input.runId && !input.wakeupRequestId) return false;
  const predicates = [
    eq(agentWakeupRequests.companyId, input.companyId),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload} ->> 'commentId' = ${input.commentId}`,
  ];
  if (input.agentId) predicates.push(eq(agentWakeupRequests.agentId, input.agentId));
  if (input.runId && input.wakeupRequestId) {
    const requestScope = or(
      eq(agentWakeupRequests.runId, input.runId),
      eq(agentWakeupRequests.id, input.wakeupRequestId),
    );
    if (requestScope) predicates.push(requestScope);
  } else if (input.runId) {
    predicates.push(eq(agentWakeupRequests.runId, input.runId));
  } else if (input.wakeupRequestId) {
    predicates.push(eq(agentWakeupRequests.id, input.wakeupRequestId));
  }

  const requests = await dbOrTx
    .select({
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    })
    .from(agentWakeupRequests)
    .where(and(...predicates));

  return requests.some((request) => actorMatchesComment(request, input.comment));
}

export async function isVerifiedIssueTreeControlInteractionWake(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    agentId?: string | null;
    contextSnapshot: Record<string, unknown> | null | undefined;
    requestedByActorType?: "user" | "agent" | "system" | string | null;
    requestedByActorId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
  },
) {
  const contextSnapshot = input.contextSnapshot ?? null;
  const wakeReason =
    readNonEmptyStringFromRecord(contextSnapshot, "wakeReason") ??
    readNonEmptyStringFromRecord(contextSnapshot, "reason");
  if (!wakeReason || !ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
  if (!contextSnapshot || !hasVerifiedInteractionSource(wakeReason, contextSnapshot)) return false;

  const commentId = readInteractionWakeCommentId(contextSnapshot);
  if (!commentId) return false;

  const comment = await dbOrTx
    .select({
      id: issueComments.id,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.id, commentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!comment) return false;

  const directActor = {
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
  };
  if (actorMatchesComment(directActor, comment)) return true;

  return hasVerifiedInteractionWakeRequest(dbOrTx, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    wakeupRequestId: input.wakeupRequestId,
    issueId: input.issueId,
    commentId,
    comment,
  });
}

function normalizeReleasePolicy(
  releasePolicy: unknown,
): IssueTreeHoldReleasePolicy {
  const note = releasePolicy && typeof releasePolicy === "object"
    && typeof (releasePolicy as Record<string, unknown>).note === "string"
    && (releasePolicy as Record<string, unknown>).note
      ? (releasePolicy as Record<string, unknown>).note as string
      : undefined;
  // Older databases may contain the never-implemented
  // `after_active_runs_finish` value. Treat it as manual on every read so the
  // API never promises an automatic release consumer that does not exist.
  return note ? { strategy: "manual", note } : DEFAULT_RELEASE_POLICY;
}

function coerceIssueStatus(status: string): IssueStatus {
  return ISSUE_STATUSES.includes(status as IssueStatus) ? (status as IssueStatus) : "backlog";
}

function isTerminalIssue(status: string): status is IssueStatus {
  return TERMINAL_ISSUE_STATUSES.has(coerceIssueStatus(status));
}

function toPreviewRun(row: ActiveRunRow): IssueTreePreviewRun {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

function toHold(row: HoldRow, members?: HoldMemberRow[]): IssueTreeHold {
  return {
    id: row.id,
    companyId: row.companyId,
    rootIssueId: row.rootIssueId,
    mode: row.mode as IssueTreeControlMode,
    status: row.status as IssueTreeHold["status"],
    reason: row.reason,
    releasePolicy: row.releasePolicy ? normalizeReleasePolicy(row.releasePolicy) : null,
    createdByActorType: row.createdByActorType as IssueTreeHold["createdByActorType"],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    releasedAt: row.releasedAt,
    releasedByActorType: row.releasedByActorType as IssueTreeHold["releasedByActorType"],
    releasedByAgentId: row.releasedByAgentId,
    releasedByUserId: row.releasedByUserId,
    releasedByRunId: row.releasedByRunId,
    releaseReason: row.releaseReason,
    releaseMetadata: row.releaseMetadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(members ? { members: members.map(toHoldMember) } : {}),
  };
}

function toHoldMember(row: HoldMemberRow): IssueTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    issueId: row.issueId,
    parentIssueId: row.parentIssueId,
    depth: row.depth,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    issueStatus: coerceIssueStatus(row.issueStatus),
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    activeRunId: row.activeRunId,
    activeRunStatus: row.activeRunStatus,
    skipped: row.skipped,
    skipReason: row.skipReason,
    createdAt: row.createdAt,
  };
}

function issueSkipReason(input: {
  mode: IssueTreeControlMode;
  issue: TreeIssue;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const status = coerceIssueStatus(input.issue.status);
  if (input.mode === "restore") {
    if (input.activeCancelSnapshot?.member && status !== "cancelled") {
      return "changed_after_cancel";
    }
    if (status !== "cancelled") return "not_cancelled";
    if (!input.activeCancelSnapshot?.member) return "not_cancelled_by_tree_control";
    const snapshotStatus = coerceIssueStatus(input.activeCancelSnapshot.member.issueStatus);
    return isTerminalIssue(snapshotStatus) ? "terminal_status" : null;
  }
  if (isTerminalIssue(status)) {
    return "terminal_status";
  }
  if (input.mode === "pause" && input.activePauseHoldIds.length > 0) {
    return "already_held";
  }
  if (input.mode === "resume" && input.activePauseHoldIds.length === 0) {
    return "not_held";
  }
  return null;
}

function buildAffectedAgents(issuesToPreview: IssueTreePreviewIssue[]): IssueTreePreviewAgent[] {
  const byAgentId = new Map<string, IssueTreePreviewAgent>();
  for (const issue of issuesToPreview) {
    if (issue.skipped) continue;
    const agentIds = new Set<string>();
    if (issue.assigneeAgentId) agentIds.add(issue.assigneeAgentId);
    if (issue.activeRun) agentIds.add(issue.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? { agentId, issueCount: 0, activeRunCount: 0 };
      current.issueCount += 1;
      if (issue.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildWarnings(input: {
  mode: IssueTreeControlMode;
  issuesToPreview: IssueTreePreviewIssue[];
  activeRuns: IssueTreePreviewRun[];
}): IssueTreePreviewWarning[] {
  const affectedIssues = input.issuesToPreview.filter((issue) => !issue.skipped);
  const affectedIssueIds = new Set(affectedIssues.map((issue) => issue.id));
  const affectedRuns = input.activeRuns.filter((run) => affectedIssueIds.has(run.issueId));
  const warnings: IssueTreePreviewWarning[] = [];

  if (affectedIssues.length === 0) {
    warnings.push({
      code: "no_affected_issues",
      message: "No issues in this subtree match the requested control action.",
    });
  }

  const runningRunIssueIds = affectedRuns
    .filter((run) => run.status === "running")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunIssueIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected issues have running heartbeat runs.",
      issueIds: [...new Set(runningRunIssueIds)].sort(),
    });
  }

  const queuedRunIssueIds = affectedRuns
    .filter((run) => run.status === "queued")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && queuedRunIssueIds.length > 0) {
    warnings.push({
      code: "queued_runs_present",
      message: "Some affected issues have queued heartbeat runs.",
      issueIds: [...new Set(queuedRunIssueIds)].sort(),
    });
  }

  if (input.mode === "resume" && affectedIssues.length === 0) {
    warnings.push({
      code: "no_active_pause_holds",
      message: "No active pause holds were found in this subtree.",
    });
  }

  if (input.mode === "restore") {
    const changedIssueIds = input.issuesToPreview
      .filter((issue) => issue.skipReason === "changed_after_cancel")
      .map((issue) => issue.id);
    if (changedIssueIds.length > 0) {
      warnings.push({
        code: "restore_conflicts_present",
        message: "Some issues changed after subtree cancellation and will be skipped.",
        issueIds: changedIssueIds,
      });
    }
  }

  return warnings;
}

function restoreStatusFromCancelSnapshot(status: IssueStatus): IssueStatus | null {
  if (status === "in_progress") return "todo";
  if (isTerminalIssue(status)) return null;
  return status;
}

export function issueTreeControlService(db: Db) {
  /**
   * Serialize creation of a tree hold with both factory workflow mutations
   * (which lock the issue row) and delivery/controller mutations (which use the
   * per-issue advisory lock). Stable ordering avoids cross-tree deadlocks.
   */
  async function acquireHoldMutationLocks(
    tx: Db,
    companyId: string,
    rawIssueIds: readonly string[],
  ) {
    const issueIds = [...new Set(rawIssueIds)].sort();
    if (issueIds.length === 0) return;
    await tx.execute(
      sql`SELECT ${issues.id} FROM ${issues}
          WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))}
          ORDER BY ${issues.id}
          FOR UPDATE`,
    );
    for (const issueId of issueIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${issueId}:delivery`}, 0))`,
      );
    }
  }

  async function listTreeIssuesUsing(
    dbOrTx: Db,
    companyId: string,
    rootIssueId: string,
    options: { lockRows?: boolean } = {},
  ): Promise<TreeIssue[]> {
    const rootSelection = dbOrTx
      .select()
      .from(issues)
      .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)));
    const root = options.lockRows
      ? await rootSelection.for("update").then((rows) => rows[0] ?? null)
      : await rootSelection.then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root issue not found");
    }

    const result: TreeIssue[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const childrenSelection = dbOrTx
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, parentIds)))
        .orderBy(asc(issues.createdAt), asc(issues.id));
      const children = options.lockRows
        ? await childrenSelection.for("update")
        : await childrenSelection;

      const nextFrontier: typeof frontier = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        const depth = (depthByParentId.get(child.parentId ?? "") ?? 0) + 1;
        visited.add(child.id);
        result.push({ ...child, depth });
        nextFrontier.push({ id: child.id, depth });
      }
      frontier = nextFrontier;
    }

    return result;
  }

  async function listTreeIssues(companyId: string, rootIssueId: string): Promise<TreeIssue[]> {
    return listTreeIssuesUsing(db, companyId, rootIssueId);
  }

  async function listLockedStableTreeIssues(tx: Db, companyId: string, rootIssueId: string) {
    // Locking each parent before selecting its children makes inserts through
    // the issue service (and the self-referential FK) wait. Re-read the tree
    // after every current member is locked so topology is never snapshotted
    // from an unlocked preflight result.
    const locked = await listTreeIssuesUsing(tx, companyId, rootIssueId, { lockRows: true });
    const revalidated = await listTreeIssuesUsing(tx, companyId, rootIssueId);
    const lockedBoundary = locked.map((issue) => `${issue.id}:${issue.parentId ?? "root"}`).sort();
    const revalidatedBoundary = revalidated.map((issue) => `${issue.id}:${issue.parentId ?? "root"}`).sort();
    if (
      lockedBoundary.length !== revalidatedBoundary.length
      || lockedBoundary.some((entry, index) => entry !== revalidatedBoundary[index])
    ) {
      throw conflict("Issue subtree changed while the tree-control operation was being locked", {
        code: "issue_tree_boundary_conflict",
        rootIssueId,
      });
    }
    return locked;
  }

  function assertExpectedTreeBoundary(
    treeIssues: TreeIssue[],
    expectedIssueIds: readonly string[] | null | undefined,
    rootIssueId: string,
  ) {
    if (!expectedIssueIds) return;
    const actual = [...new Set(treeIssues.map((issue) => issue.id))].sort();
    const expected = [...new Set(expectedIssueIds)].sort();
    if (actual.length !== expected.length || actual.some((issueId, index) => issueId !== expected[index])) {
      throw conflict("Issue subtree changed after authorization", {
        code: "issue_tree_boundary_conflict",
        rootIssueId,
      });
    }
  }

  async function activeRunsForTree(
    companyId: string,
    treeIssues: TreeIssue[],
    dbOrTx: Db = db,
  ) {
    const issueIds = treeIssues.map((issue) => issue.id);
    if (issueIds.length === 0) return [];
    const runIds = treeIssues
      .map((issue) => issue.executionRunId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const uniqueRunIds = [...new Set(runIds)];
    const issueIdFromContext = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const issueIdSet = new Set(issueIds);

    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        issueIdFromContext,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          uniqueRunIds.length > 0
            ? or(inArray(heartbeatRuns.id, uniqueRunIds), inArray(issueIdFromContext, issueIds))
            : inArray(issueIdFromContext, issueIds),
        ),
      );

    const issueIdByExecutionRunId = new Map(
      treeIssues
        .filter((issue) => issue.executionRunId)
        .map((issue) => [issue.executionRunId as string, issue.id]),
    );
    return rows
      .map((run) => {
        if (run.status !== "queued" && run.status !== "running") return null;
        const issueId = run.issueIdFromContext && issueIdSet.has(run.issueIdFromContext)
          ? run.issueIdFromContext
          : issueIdByExecutionRunId.get(run.id) ?? null;
        if (!issueId) return null;
        return {
          id: run.id,
          issueId,
          agentId: run.agentId,
          status: run.status,
          startedAt: run.startedAt,
          createdAt: run.createdAt,
        } satisfies ActiveRunRow;
      })
      .filter((run): run is ActiveRunRow => run !== null)
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function activeHoldsByIssueId(companyId: string, issueIds: string[], dbOrTx: Db = db) {
    const byIssueId = new Map<string, { all: string[]; pause: string[] }>();
    if (issueIds.length === 0) return byIssueId;
    const rows = await dbOrTx
      .select({
        issueId: issueTreeHoldMembers.issueId,
        holdId: issueTreeHolds.id,
        mode: issueTreeHolds.mode,
      })
      .from(issueTreeHoldMembers)
      .innerJoin(issueTreeHolds, eq(issueTreeHoldMembers.holdId, issueTreeHolds.id))
      .where(
        and(
          eq(issueTreeHoldMembers.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          inArray(issueTreeHoldMembers.issueId, issueIds),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));

    for (const row of rows) {
      const current = byIssueId.get(row.issueId) ?? { all: [], pause: [] };
      current.all.push(row.holdId);
      if (row.mode === "pause") current.pause.push(row.holdId);
      byIssueId.set(row.issueId, current);
    }
    return byIssueId;
  }

  async function activeCancelSnapshotsByIssueId(
    companyId: string,
    rootIssueId: string,
    dbOrTx: Db = db,
  ) {
    const activeCancelHolds = await listHoldsUsing(dbOrTx, companyId, rootIssueId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byIssueId = new Map<string, ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byIssueId.get(member.issueId) ?? { holdIds: [], member: null };
        if (!current.holdIds.includes(hold.id)) current.holdIds.push(hold.id);
        if (!current.member && !member.skipped) current.member = member;
        byIssueId.set(member.issueId, current);
      }
    }
    return byIssueId;
  }

  async function listOverlappingActiveCancelHolds(
    tx: Db,
    companyId: string,
    treeIssues: TreeIssue[],
  ): Promise<HoldRow[]> {
    const root = treeIssues[0] ?? null;
    if (!root) return [];

    // A cancel rooted anywhere inside this tree overlaps descendants. A cancel
    // rooted on any ancestor overlaps the requested root. Tree rows are already
    // locked by createHold, and locking the matching hold rows keeps this result
    // stable against a concurrent typed restore.
    const overlappingRootIssueIds = new Set(treeIssues.map((issue) => issue.id));
    const visited = new Set<string>(overlappingRootIssueIds);
    let currentIssueId = root.parentId;
    while (
      currentIssueId
      && !visited.has(currentIssueId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH + treeIssues.length
    ) {
      visited.add(currentIssueId);
      overlappingRootIssueIds.add(currentIssueId);
      const parent = await tx
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentIssueId = parent?.parentId ?? null;
    }

    return tx
      .select()
      .from(issueTreeHolds)
      .where(and(
        eq(issueTreeHolds.companyId, companyId),
        eq(issueTreeHolds.status, "active"),
        eq(issueTreeHolds.mode, "cancel"),
        inArray(issueTreeHolds.rootIssueId, [...overlappingRootIssueIds]),
      ))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id))
      .for("update");
  }

  function throwCancelHoldOverlap(
    rootIssueId: string,
    hold: Pick<HoldRow, "id" | "rootIssueId">,
    operation: "cancel" | "restore",
  ): never {
    throw conflict(
      operation === "cancel"
        ? "This subtree is already covered by an active cancel hold. Restore the existing hold before cancelling it again."
        : "This restore overlaps another active cancel hold and cannot safely revive the subtree.",
      {
        code: "issue_tree_cancel_hold_overlap",
        requestedRootIssueId: rootIssueId,
        activeHoldId: hold.id,
        activeRootIssueId: hold.rootIssueId,
        operation,
      },
    );
  }

  async function activePauseHoldsForIssueIds(companyId: string, issueIds: string[], dbOrTx: Db = db) {
    if (issueIds.length === 0) return [];
    const selection = dbOrTx
      .select()
      .from(issueTreeHolds)
      .where(
        and(
          eq(issueTreeHolds.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
          inArray(issueTreeHolds.rootIssueId, issueIds),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    return dbOrTx === db ? selection : selection.for("update");
  }

  async function getActivePauseHoldGate(
    companyId: string,
    issueId: string,
  ): Promise<ActiveIssueTreePauseHoldGate | null> {
    const activePauseHolds = await db
      .select({
        id: issueTreeHolds.id,
        rootIssueId: issueTreeHolds.rootIssueId,
        reason: issueTreeHolds.reason,
        releasePolicy: issueTreeHolds.releasePolicy,
      })
      .from(issueTreeHolds)
      .where(
        and(
          eq(issueTreeHolds.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (activePauseHolds.length === 0) return null;

    const holdByRootIssueId = new Map(activePauseHolds.map((hold) => [hold.rootIssueId, hold]));
    let currentIssueId: string | null = issueId;
    const visited = new Set<string>();

    while (
      currentIssueId
      && !visited.has(currentIssueId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH
    ) {
      visited.add(currentIssueId);
      const hold = holdByRootIssueId.get(currentIssueId);
      if (hold) {
        return {
          holdId: hold.id,
          rootIssueId: hold.rootIssueId,
          issueId,
          isRoot: hold.rootIssueId === issueId,
          mode: "pause",
          reason: hold.reason,
          releasePolicy: hold.releasePolicy ? normalizeReleasePolicy(hold.releasePolicy) : null,
        };
      }

      const parent: { parentId: string | null } | null = await db
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentIssueId = parent?.parentId ?? null;
    }

    return null;
  }

  async function getActiveCancelHoldGate(
    companyId: string,
    issueId: string,
  ): Promise<ActiveIssueTreeCancelHoldGate | null> {
    const activeCancelHolds = await db
      .select({
        id: issueTreeHolds.id,
        rootIssueId: issueTreeHolds.rootIssueId,
        reason: issueTreeHolds.reason,
        releasePolicy: issueTreeHolds.releasePolicy,
      })
      .from(issueTreeHolds)
      .where(and(
        eq(issueTreeHolds.companyId, companyId),
        eq(issueTreeHolds.status, "active"),
        eq(issueTreeHolds.mode, "cancel"),
      ))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (activeCancelHolds.length === 0) return null;

    const holdByRootIssueId = new Map(activeCancelHolds.map((hold) => [hold.rootIssueId, hold]));
    let currentIssueId: string | null = issueId;
    const visited = new Set<string>();
    while (
      currentIssueId
      && !visited.has(currentIssueId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH
    ) {
      visited.add(currentIssueId);
      const hold = holdByRootIssueId.get(currentIssueId);
      if (hold) {
        return {
          holdId: hold.id,
          rootIssueId: hold.rootIssueId,
          issueId,
          isRoot: hold.rootIssueId === issueId,
          mode: "cancel",
          reason: hold.reason,
          releasePolicy: hold.releasePolicy ? normalizeReleasePolicy(hold.releasePolicy) : null,
        };
      }
      const parent: { parentId: string | null } | null = await db
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      currentIssueId = parent?.parentId ?? null;
    }
    return null;
  }

  async function buildPreview(
    dbOrTx: Db,
    companyId: string,
    rootIssueId: string,
    treeIssues: TreeIssue[],
    input: {
      mode: IssueTreeControlMode;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
    },
  ): Promise<IssueTreeControlPreview> {
    const issueIds = treeIssues.map((issue) => issue.id);
    const [activeRunRows, holdsByIssueId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeIssues, dbOrTx),
      activeHoldsByIssueId(companyId, issueIds, dbOrTx),
      input.mode === "restore"
        ? activeCancelSnapshotsByIssueId(companyId, rootIssueId, dbOrTx)
        : Promise.resolve(new Map<string, ActiveCancelSnapshot>()),
    ]);
    const runsByIssueId = new Map<string, ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByIssueId.has(run.issueId)) runsByIssueId.set(run.issueId, run);
    }
    const countsByStatus: Partial<Record<IssueStatus, number>> = {};

    const issuesToPreview = treeIssues.map((issue) => {
      const status = coerceIssueStatus(issue.status);
      countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;
      const holdState = holdsByIssueId.get(issue.id) ?? { all: [], pause: [] };
      const skipReason = issueSkipReason({
        mode: input.mode,
        issue,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(issue.id) ?? null,
      });
      const run = runsByIssueId.get(issue.id);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status,
        parentId: issue.parentId,
        depth: issue.depth,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        activeRun: run ? toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies IssueTreePreviewIssue;
    });
    const skippedIssues = issuesToPreview.filter((issue) => issue.skipped);
    const activeRuns = activeRunRows
      .map(toPreviewRun)
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.id.localeCompare(b.id));
    const affectedAgents = buildAffectedAgents(issuesToPreview);

    return {
      companyId,
      rootIssueId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: normalizeReleasePolicy(input.releasePolicy),
      totals: {
        totalIssues: issuesToPreview.length,
        affectedIssues: issuesToPreview.length - skippedIssues.length,
        skippedIssues: skippedIssues.length,
        activeRuns: activeRuns.filter((run) => run.status === "running").length,
        queuedRuns: activeRuns.filter((run) => run.status === "queued").length,
        affectedAgents: affectedAgents.length,
      },
      countsByStatus,
      issues: issuesToPreview,
      skippedIssues,
      activeRuns,
      affectedAgents,
      warnings: buildWarnings({ mode: input.mode, issuesToPreview, activeRuns }),
    };
  }

  async function preview(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      expectedIssueIds?: string[];
    },
  ): Promise<IssueTreeControlPreview> {
    const treeIssues = await listTreeIssues(companyId, rootIssueId);
    assertExpectedTreeBoundary(treeIssues, input.expectedIssueIds, rootIssueId);
    return buildPreview(db, companyId, rootIssueId, treeIssues, input);
  }

  async function insertHoldSnapshot(
    tx: Db,
    companyId: string,
    rootIssueId: string,
    preview: IssueTreeControlPreview,
    input: {
      mode: IssueTreeControlMode;
      reason?: string | null;
      releasePolicy: IssueTreeHoldReleasePolicy;
      actor: ActorInput;
    },
  ) {
    const [createdHold] = await tx
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: input.mode,
        status: "active",
        reason: input.reason ?? null,
        releasePolicy: input.releasePolicy as unknown as Record<string, unknown>,
        createdByActorType: input.actor.actorType,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
        createdByRunId: input.actor.runId ?? null,
      })
      .returning();
    const memberRows = preview.issues.map((issue) => ({
      companyId,
      holdId: createdHold.id,
      issueId: issue.id,
      parentIssueId: issue.parentId,
      depth: issue.depth,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueStatus: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      activeRunId: issue.activeRun?.id ?? null,
      activeRunStatus: issue.activeRun?.status ?? null,
      skipped: issue.skipped,
      skipReason: issue.skipReason,
    }));
    const members = memberRows.length > 0
      ? await tx.insert(issueTreeHoldMembers).values(memberRows).returning()
      : [];
    return { hold: createdHold, members };
  }

  async function applyCancelStatuses(
    tx: Db,
    companyId: string,
    members: HoldMemberRow[],
  ): Promise<TreeStatusUpdateResult> {
    const issueIds = [...new Set(members.filter((member) => !member.skipped).map((member) => member.issueId))];
    if (issueIds.length === 0) return { updatedIssueIds: [], updatedIssues: [] };
    const now = new Date();
    const updated = await tx
      .update(issues)
      .set({
        status: "cancelled",
        cancelledAt: now,
        completedAt: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(issues.companyId, companyId),
        inArray(issues.id, issueIds),
        notInArray(issues.status, ["done", "cancelled"]),
      ))
      .returning({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId });
    return {
      updatedIssueIds: updated.map((issue) => issue.id),
      updatedIssues: updated.map((issue) => ({
        id: issue.id,
        status: coerceIssueStatus(issue.status),
        assigneeAgentId: issue.assigneeAgentId,
      })),
    };
  }

  async function releaseHoldRow(
    tx: Db,
    companyId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
    },
    existingReleasePolicy?: Record<string, unknown> | null,
  ) {
    const [updated] = await tx
      .update(issueTreeHolds)
      .set({
        status: "released",
        releasedAt: new Date(),
        releasedByActorType: input.actor.actorType,
        releasedByAgentId: input.actor.agentId ?? null,
        releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
        releasedByRunId: input.actor.runId ?? null,
        releaseReason: input.reason ?? null,
        releasePolicy: input.releasePolicy
          ? (normalizeReleasePolicy(input.releasePolicy) as unknown as Record<string, unknown>)
          : existingReleasePolicy,
        releaseMetadata: input.metadata ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(issueTreeHolds.id, holdId),
        eq(issueTreeHolds.companyId, companyId),
        eq(issueTreeHolds.status, "active"),
      ))
      .returning();
    if (!updated) throw conflict("Issue tree hold is already released");
    return updated;
  }

  async function applyRestoreStatuses(
    tx: Db,
    companyId: string,
    restoreHold: HoldRow,
    restoreMembers: HoldMemberRow[],
    activeCancelHolds: IssueTreeHold[],
    input: { reason?: string | null; actor: ActorInput },
  ): Promise<RestoreTreeStatusResult> {
    const cancelSnapshotByIssueId = new Map<string, IssueTreeHoldMember>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        if (!member.skipped && !cancelSnapshotByIssueId.has(member.issueId)) {
          cancelSnapshotByIssueId.set(member.issueId, member);
        }
      }
    }
    const restoreStatusByIssueId = new Map<string, IssueStatus>();
    for (const member of restoreMembers) {
      if (member.skipped) continue;
      const snapshot = cancelSnapshotByIssueId.get(member.issueId);
      if (!snapshot) continue;
      const restoredStatus = restoreStatusFromCancelSnapshot(coerceIssueStatus(snapshot.issueStatus));
      if (restoredStatus) restoreStatusByIssueId.set(member.issueId, restoredStatus);
    }
    const issueIdsByStatus = new Map<IssueStatus, string[]>();
    for (const [issueId, status] of restoreStatusByIssueId) {
      const current = issueIdsByStatus.get(status) ?? [];
      current.push(issueId);
      issueIdsByStatus.set(status, current);
    }
    const now = new Date();
    const restored: TreeStatusUpdateResult["updatedIssues"] = [];
    for (const [status, issueIdsForStatus] of issueIdsByStatus) {
      const rows = await tx
        .update(issues)
        .set({
          status,
          cancelledAt: null,
          completedAt: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIdsForStatus),
          eq(issues.status, "cancelled"),
        ))
        .returning({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId });
      restored.push(...rows.map((issue) => ({
        id: issue.id,
        status: coerceIssueStatus(issue.status),
        assigneeAgentId: issue.assigneeAgentId,
      })));
    }
    const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
    for (const cancelHold of activeCancelHolds) {
      await releaseHoldRow(tx, companyId, cancelHold.id, {
        reason: input.reason ?? "Restored by subtree restore operation",
        metadata: { restoreHoldId: restoreHold.id, restoredIssueIds: restored.map((issue) => issue.id) },
        actor: input.actor,
      }, cancelHold.releasePolicy as unknown as Record<string, unknown> | null);
    }
    const releasedRestore = await releaseHoldRow(tx, companyId, restoreHold.id, {
      reason: input.reason ?? "Restore operation applied",
      metadata: { restoredIssueIds: restored.map((issue) => issue.id), releasedCancelHoldIds },
      actor: input.actor,
    }, restoreHold.releasePolicy);
    return {
      updatedIssueIds: restored.map((issue) => issue.id),
      updatedIssues: restored,
      releasedCancelHoldIds,
      restoreHold: toHold(releasedRestore, restoreMembers),
    };
  }

  async function createHold(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      actor: ActorInput;
      expectedIssueIds?: string[];
      /**
       * Route-owned authorization recheck. The service invokes this only
       * after the complete subtree is stable and row-locked, so project,
       * visibility, and collaborator changes cannot race the mutation.
       */
      authorizeLockedBoundary?: () => Promise<void>;
    },
  ): Promise<CreateHoldResult> {
    const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const treeIssues = await listLockedStableTreeIssues(tx, companyId, rootIssueId);
      assertExpectedTreeBoundary(treeIssues, input.expectedIssueIds, rootIssueId);
      const issueIds = treeIssues.map((issue) => issue.id);
      await acquireHoldMutationLocks(tx, companyId, issueIds);
      await input.authorizeLockedBoundary?.();
      const overlappingCancelHolds = input.mode === "cancel" || input.mode === "restore"
        ? await listOverlappingActiveCancelHolds(tx, companyId, treeIssues)
        : [];
      if (input.mode === "cancel" && overlappingCancelHolds.length > 0) {
        throwCancelHoldOverlap(rootIssueId, overlappingCancelHolds[0]!, "cancel");
      }
      if (input.mode === "restore") {
        // Historical releases could create nested active cancel holds. Never
        // restore a status beneath one: that would make the issue actionable
        // while an explicit cancellation still covers it. New overlapping
        // holds are rejected above; this remains as fail-secure legacy defense.
        const foreignOverlap = overlappingCancelHolds.find((hold) => hold.rootIssueId !== rootIssueId);
        if (foreignOverlap) throwCancelHoldOverlap(rootIssueId, foreignOverlap, "restore");
      }
      const activePauseHolds = input.mode === "resume"
        ? await activePauseHoldsForIssueIds(companyId, issueIds, tx)
        : [];
      const activeCancelHolds = input.mode === "restore"
        ? await listHoldsUsing(tx, companyId, rootIssueId, {
            status: "active",
            mode: "cancel",
            includeMembers: true,
            lockRows: true,
          })
        : [];
      const holdPreview = await buildPreview(tx, companyId, rootIssueId, treeIssues, {
        mode: input.mode,
        releasePolicy: holdReleasePolicy,
      });
      const { hold, members } = await insertHoldSnapshot(tx, companyId, rootIssueId, holdPreview, {
        ...input,
        releasePolicy: holdReleasePolicy,
      });

      if (input.mode === "cancel") {
        const statusUpdate = await applyCancelStatuses(tx, companyId, members);
        return { hold: toHold(hold, members), preview: holdPreview, statusUpdate };
      }
      if (input.mode === "restore") {
        const statusUpdate = await applyRestoreStatuses(
          tx,
          companyId,
          hold,
          members,
          activeCancelHolds,
          { reason: input.reason, actor: input.actor },
        );
        return { hold: statusUpdate.restoreHold ?? toHold(hold, members), preview: holdPreview, statusUpdate };
      }
      if (input.mode === "resume") {
        const releaseReason = input.reason ?? "Subtree resume applied.";
        const resumedPauseHoldIds = activePauseHolds.map((pauseHold) => pauseHold.id);
        for (const pauseHold of activePauseHolds) {
          await releaseHoldRow(tx, companyId, pauseHold.id, {
            reason: releaseReason,
            metadata: {
              resumedByResumeHoldId: hold.id,
              resumeHoldMode: "tree_resume",
              resumedPauseHoldId: pauseHold.id,
            },
            actor: input.actor,
          }, pauseHold.releasePolicy);
        }
        const releasedResume = await releaseHoldRow(tx, companyId, hold.id, {
          reason: releaseReason,
          metadata: {
            resumedPauseHoldIds,
            resumeMode: "subtree",
            ...(input.releasePolicy ? { releasePolicy: holdReleasePolicy } : {}),
          },
          actor: input.actor,
        }, hold.releasePolicy);
        return {
          hold: toHold(releasedResume, members),
          preview: holdPreview,
          resumedPauseHoldIds,
        };
      }
      return { hold: toHold(hold, members), preview: holdPreview };
    });
  }

  async function cancelIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
  ): Promise<TreeStatusUpdateResult> {
    const hold = await getHold(companyId, holdId);
    if (!hold) throw notFound("Issue tree hold not found");
    if (hold.rootIssueId !== rootIssueId) {
      throw unprocessable("Issue tree hold does not belong to the requested root issue");
    }
    if (hold.mode !== "cancel") throw unprocessable("Issue tree hold is not a cancel operation");
    // Cancel holds created by createHold already apply their status snapshot in
    // the same transaction. This remains as an idempotent compatibility API.
    return { updatedIssueIds: [], updatedIssues: [] };
  }

  async function restoreIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    restoreHoldId: string,
    _input: { reason?: string | null; actor: ActorInput },
  ): Promise<RestoreTreeStatusResult> {
    const hold = await getHold(companyId, restoreHoldId);
    if (!hold) throw notFound("Issue tree hold not found");
    if (hold.rootIssueId !== rootIssueId) {
      throw unprocessable("Issue tree hold does not belong to the requested root issue");
    }
    if (hold.mode !== "restore") throw unprocessable("Issue tree hold is not a restore operation");
    if (hold.status !== "released") {
      throw conflict("Restore hold has not been applied atomically");
    }
    const metadata = hold.releaseMetadata ?? {};
    const updatedIssueIds = Array.isArray(metadata.restoredIssueIds)
      ? metadata.restoredIssueIds.filter((value): value is string => typeof value === "string")
      : [];
    const releasedCancelHoldIds = Array.isArray(metadata.releasedCancelHoldIds)
      ? metadata.releasedCancelHoldIds.filter((value): value is string => typeof value === "string")
      : [];
    const updatedIssues = updatedIssueIds.length === 0
      ? []
      : await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, updatedIssueIds)))
        .then((rows) => rows.map((issue) => ({
          id: issue.id,
          status: coerceIssueStatus(issue.status),
          assigneeAgentId: issue.assigneeAgentId,
        })));
    return { updatedIssueIds, updatedIssues, releasedCancelHoldIds, restoreHold: hold };
  }

  async function getHoldUsing(dbOrTx: Db, companyId: string, holdId: string) {
    const hold = await dbOrTx
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await dbOrTx
      .select()
      .from(issueTreeHoldMembers)
      .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));
    return toHold(hold, members);
  }

  async function getHold(companyId: string, holdId: string) {
    return getHoldUsing(db, companyId, holdId);
  }

  async function listHoldsUsing(
    dbOrTx: Db,
    companyId: string,
    rootIssueId: string,
    input?: {
      status?: IssueTreeHold["status"];
      mode?: IssueTreeControlMode;
      includeMembers?: boolean;
      lockRows?: boolean;
    },
  ) {
    const whereClauses = [
      eq(issueTreeHolds.companyId, companyId),
      eq(issueTreeHolds.rootIssueId, rootIssueId),
    ];
    if (input?.status) whereClauses.push(eq(issueTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(issueTreeHolds.mode, input.mode));

    const holdSelection = dbOrTx
      .select()
      .from(issueTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    const holds = input?.lockRows ? await holdSelection.for("update") : await holdSelection;
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => toHold(hold));
    }

    const holdIds = holds.map((hold) => hold.id);
    const members = await dbOrTx
      .select()
      .from(issueTreeHoldMembers)
      .where(
        and(
          eq(issueTreeHoldMembers.companyId, companyId),
          inArray(issueTreeHoldMembers.holdId, holdIds),
        ),
      )
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));

    const membersByHoldId = new Map<string, HoldMemberRow[]>();
    for (const member of members) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }

    return holds.map((hold) => toHold(hold, membersByHoldId.get(hold.id) ?? []));
  }

  async function listHolds(
    companyId: string,
    rootIssueId: string,
    input?: {
      status?: IssueTreeHold["status"];
      mode?: IssueTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    return listHoldsUsing(db, companyId, rootIssueId, input);
  }

  async function releaseHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
      expectedIssueIds?: string[];
      /** See createHold.authorizeLockedBoundary. */
      authorizeLockedBoundary?: () => Promise<void>;
    },
  ) {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      if (input.expectedIssueIds) {
        const treeIssues = await listLockedStableTreeIssues(tx, companyId, rootIssueId);
        assertExpectedTreeBoundary(treeIssues, input.expectedIssueIds, rootIssueId);
        await acquireHoldMutationLocks(tx, companyId, treeIssues.map((issue) => issue.id));
        await input.authorizeLockedBoundary?.();
      }
      const existing = await tx
        .select()
        .from(issueTreeHolds)
        .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Issue tree hold not found");
      if (existing.rootIssueId !== rootIssueId) {
        throw unprocessable("Issue tree hold does not belong to the requested root issue");
      }
      if (existing.status === "released") throw conflict("Issue tree hold is already released");
      if (existing.mode === "cancel") {
        throw conflict("Cancel holds can only be released by the typed restore operation.", {
          code: "issue_tree_restore_required",
          holdId: existing.id,
          rootIssueId: existing.rootIssueId,
          managedMode: "restore",
        });
      }
      const updated = await releaseHoldRow(tx, companyId, holdId, input, existing.releasePolicy);
      const members = await tx
        .select()
        .from(issueTreeHoldMembers)
        .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.holdId, holdId)))
        .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));
      return toHold(updated, members);
    });
  }

  async function cancelUnclaimedWakeupsForTree(companyId: string, rootIssueId: string, reason: string) {
    const treeIssues = await listTreeIssues(companyId, rootIssueId);
    const issueIds = treeIssues.map((issue) => issue.id);
    if (issueIds.length === 0) return [];
    const now = new Date();
    return db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
          inArray(sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`, issueIds),
        ),
      )
      .returning({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      });
  }

  return {
    listTreeIssues,
    preview,
    createHold,
    cancelIssueStatusesForHold,
    restoreIssueStatusesForHold,
    getHold,
    listHolds,
    getActivePauseHoldGate,
    getActiveCancelHoldGate,
    releaseHold,
    cancelUnclaimedWakeupsForTree,
  };
}
