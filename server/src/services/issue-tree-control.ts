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

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const DEFAULT_RELEASE_POLICY: IssueTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
export const ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_comment_mentioned",
] as const);
const ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  issue_commented: new Set(["issue.comment"]),
  issue_reopened_via_comment: new Set(["issue.comment.reopen"]),
  issue_comment_mentioned: new Set(["comment.mention"]),
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
  releasePolicy: IssueTreeHoldReleasePolicy | null | undefined,
): IssueTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
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
    releasePolicy: (row.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
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
  async function listTreeIssues(companyId: string, rootIssueId: string): Promise<TreeIssue[]> {
    const root = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root issue not found");
    }

    const result: TreeIssue[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const children = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, parentIds)))
        .orderBy(asc(issues.createdAt), asc(issues.id));

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

  async function activeRunsForTree(companyId: string, treeIssues: TreeIssue[]) {
    const issueIds = treeIssues.map((issue) => issue.id);
    if (issueIds.length === 0) return [];
    const runIds = treeIssues
      .map((issue) => issue.executionRunId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const uniqueRunIds = [...new Set(runIds)];
    const issueIdFromContext = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const issueIdSet = new Set(issueIds);

    const rows = await db
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

  async function activeHoldsByIssueId(companyId: string, issueIds: string[]) {
    const byIssueId = new Map<string, { all: string[]; pause: string[] }>();
    if (issueIds.length === 0) return byIssueId;
    const rows = await db
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

  async function activeCancelSnapshotsByIssueId(companyId: string, rootIssueId: string) {
    const activeCancelHolds = await listHolds(companyId, rootIssueId, {
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

  async function activePauseHoldsForIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    return db
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
          releasePolicy: (hold.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
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

  async function preview(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
    },
  ): Promise<IssueTreeControlPreview> {
    const treeIssues = await listTreeIssues(companyId, rootIssueId);
    const issueIds = treeIssues.map((issue) => issue.id);
    const [activeRunRows, holdsByIssueId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeIssues),
      activeHoldsByIssueId(companyId, issueIds),
      input.mode === "restore"
        ? activeCancelSnapshotsByIssueId(companyId, rootIssueId)
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

  async function createHold(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      actor: ActorInput;
    },
  ): Promise<{
    hold: IssueTreeHold;
    preview: IssueTreeControlPreview;
    resumedPauseHoldIds?: string[];
  }> {
    const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
    const holdPreview = await preview(companyId, rootIssueId, {
      mode: input.mode,
      releasePolicy: holdReleasePolicy,
    });

    if (input.mode === "resume") {
      const issueIds = [...new Set(holdPreview.issues.map((issue) => issue.id))];
      const activePauseHolds = await activePauseHoldsForIssueIds(companyId, issueIds);
      const releaseReason = input.reason ?? "Subtree resume applied.";

      const { hold: resumeHold } = await db.transaction(async (tx) => {
        const [createdHold] = await tx
          .insert(issueTreeHolds)
          .values({
            companyId,
            rootIssueId,
            mode: input.mode,
            status: "active",
            reason: input.reason ?? null,
            releasePolicy: holdReleasePolicy as unknown as Record<string, unknown>,
            createdByActorType: input.actor.actorType,
            createdByAgentId: input.actor.agentId ?? null,
            createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            createdByRunId: input.actor.runId ?? null,
          })
          .returning();

        const memberRows = holdPreview.issues.map((issue) => ({
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

        const createdMembers = memberRows.length > 0
          ? await tx
            .insert(issueTreeHoldMembers)
            .values(memberRows)
            .returning()
          : [];

        return { hold: toHold(createdHold, createdMembers) };
      });

      const resumedPauseHoldIds = activePauseHolds.map((hold) => hold.id);
      if (resumedPauseHoldIds.length > 0) {
        await Promise.all(
          activePauseHolds.map((pauseHold) =>
            releaseHold(companyId, pauseHold.rootIssueId, pauseHold.id, {
              reason: releaseReason,
              metadata: {
                resumedByResumeHoldId: resumeHold.id,
                resumeHoldMode: "tree_resume",
                resumedPauseHoldId: pauseHold.id,
              },
              actor: input.actor,
            }),
          ),
        );
      }

      const releasedResumeHold = await releaseHold(companyId, rootIssueId, resumeHold.id, {
        reason: releaseReason,
        metadata: {
          resumedPauseHoldIds,
          resumeMode: "subtree",
          ...(input.releasePolicy ? { releasePolicy: holdReleasePolicy } : {}),
        },
        actor: input.actor,
      });

      return {
        hold: releasedResumeHold,
        preview: holdPreview,
        resumedPauseHoldIds,
      };
    }

    const { hold, members } = await db.transaction(async (tx) => {
      const [createdHold] = await tx
        .insert(issueTreeHolds)
        .values({
          companyId,
          rootIssueId,
          mode: input.mode,
          status: "active",
          reason: input.reason ?? null,
          releasePolicy: holdReleasePolicy as unknown as Record<string, unknown>,
          createdByActorType: input.actor.actorType,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          createdByRunId: input.actor.runId ?? null,
        })
        .returning();

      const memberRows = holdPreview.issues.map((issue) => ({
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

      const createdMembers = memberRows.length > 0
        ? await tx.insert(issueTreeHoldMembers).values(memberRows).returning()
        : [];

      return { hold: createdHold, members: createdMembers };
    });

    return {
      hold: toHold(hold, members),
      preview: holdPreview,
    };
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
    if (hold.mode !== "cancel") {
      throw unprocessable("Issue tree hold is not a cancel operation");
    }

    const issueIds = [...new Set((hold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.issueId))];
    if (issueIds.length === 0) return { updatedIssueIds: [], updatedIssues: [] };

    const now = new Date();
    const updated = await db
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
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIds),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      });

    return {
      updatedIssueIds: updated.map((issue) => issue.id),
      updatedIssues: updated.map((issue) => ({
        id: issue.id,
        status: coerceIssueStatus(issue.status),
        assigneeAgentId: issue.assigneeAgentId,
      })),
    };
  }

  async function restoreIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: ActorInput;
    },
  ): Promise<RestoreTreeStatusResult> {
    const restoreHold = await getHold(companyId, restoreHoldId);
    if (!restoreHold) throw notFound("Issue tree hold not found");
    if (restoreHold.rootIssueId !== rootIssueId) {
      throw unprocessable("Issue tree hold does not belong to the requested root issue");
    }
    if (restoreHold.mode !== "restore") {
      throw unprocessable("Issue tree hold is not a restore operation");
    }

    const activeCancelHolds = await listHolds(companyId, rootIssueId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const cancelSnapshotByIssueId = new Map<string, IssueTreeHoldMember>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        if (!member.skipped && !cancelSnapshotByIssueId.has(member.issueId)) {
          cancelSnapshotByIssueId.set(member.issueId, member);
        }
      }
    }

    const restoreIssueIds = [...new Set((restoreHold.members ?? [])
      .filter((member) => !member.skipped)
      .map((member) => member.issueId))];
    const restoreStatusByIssueId = new Map<string, IssueStatus>();
    for (const issueId of restoreIssueIds) {
      const snapshot = cancelSnapshotByIssueId.get(issueId);
      if (!snapshot) continue;
      const restoredStatus = restoreStatusFromCancelSnapshot(coerceIssueStatus(snapshot.issueStatus));
      if (restoredStatus) restoreStatusByIssueId.set(issueId, restoredStatus);
    }

    const issueIdsByStatus = new Map<IssueStatus, string[]>();
    for (const [issueId, status] of restoreStatusByIssueId) {
      const current = issueIdsByStatus.get(status) ?? [];
      current.push(issueId);
      issueIdsByStatus.set(status, current);
    }

    const now = new Date();
    const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
    const updatedIssues = await db.transaction(async (tx) => {
      const restored: TreeStatusUpdateResult["updatedIssues"] = [];
      for (const [status, issueIdsForStatus] of issueIdsByStatus) {
        if (issueIdsForStatus.length === 0) continue;
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
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.id, issueIdsForStatus),
              eq(issues.status, "cancelled"),
            ),
          )
          .returning({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          });
        restored.push(...rows.map((issue) => ({
          id: issue.id,
          status: coerceIssueStatus(issue.status),
          assigneeAgentId: issue.assigneeAgentId,
        })));
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(issueTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredIssueIds: restored.map((issue) => issue.id),
            },
            updatedAt: now,
          })
          .where(and(eq(issueTreeHolds.companyId, companyId), inArray(issueTreeHolds.id, releasedCancelHoldIds)));
      }

      await tx
        .update(issueTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredIssueIds: restored.map((issue) => issue.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.id, restoreHoldId)));

      return restored;
    });

    return {
      updatedIssueIds: updatedIssues.map((issue) => issue.id),
      updatedIssues,
      releasedCancelHoldIds,
      restoreHold: await getHold(companyId, restoreHoldId),
    };
  }

  async function getHold(companyId: string, holdId: string) {
    const hold = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await db
      .select()
      .from(issueTreeHoldMembers)
      .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));
    return toHold(hold, members);
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
    const whereClauses = [
      eq(issueTreeHolds.companyId, companyId),
      eq(issueTreeHolds.rootIssueId, rootIssueId),
    ];
    if (input?.status) whereClauses.push(eq(issueTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(issueTreeHolds.mode, input.mode));

    const holds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (!input?.includeMembers || holds.length === 0) {
      return holds.map((hold) => toHold(hold));
    }

    const holdIds = holds.map((hold) => hold.id);
    const members = await db
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

  async function releaseHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
    input: {
      reason?: string | null;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
      metadata?: Record<string, unknown> | null;
      actor: ActorInput;
    },
  ) {
    const existing = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Issue tree hold not found");
    if (existing.rootIssueId !== rootIssueId) {
      throw unprocessable("Issue tree hold does not belong to the requested root issue");
    }
    if (existing.status === "released") {
      throw conflict("Issue tree hold is already released");
    }

    const [updated] = await db
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
          : existing.releasePolicy,
        releaseMetadata: input.metadata ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .returning();

    const members = await db
      .select()
      .from(issueTreeHoldMembers)
      .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.holdId, holdId)))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));

    return toHold(updated, members);
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
    releaseHold,
    cancelUnclaimedWakeupsForTree,
  };
}
