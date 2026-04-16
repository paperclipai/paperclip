import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueRelations, issues } from "@paperclipai/db";
import type {
  IssueBlockerPathNode,
  IssueBoardState,
  IssuePrimaryBlocker,
  IssueRootBlocker,
  IssueStatus,
} from "@paperclipai/shared";

type IssueBoardStateRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type AgentSummary = {
  id: string;
  name: string;
  role: string;
};

type RootPath = {
  rootId: string;
  path: string[];
};

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export type ComputedIssueBoardState = {
  boardState: IssueBoardState;
  primaryBlocker: IssuePrimaryBlocker | null;
  rootBlockers?: IssueRootBlocker[];
  blockerPath?: IssueBlockerPathNode[];
};

const PRIORITY_WEIGHTS: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  urgent: 5,
};

function priorityWeight(priority: string | null | undefined) {
  if (!priority) return 0;
  return PRIORITY_WEIGHTS[priority] ?? 0;
}

function latestTimestampMs(issue: Pick<IssueBoardStateRow, "updatedAt" | "createdAt">) {
  return issue.updatedAt.getTime() || issue.createdAt.getTime();
}

function makeIssueAction(
  issueId: string,
  label: string,
): IssueBoardState["primaryAction"] {
  return {
    type: "open_issue",
    label,
    targetEntity: "issue",
    targetId: issueId,
  };
}

function makeAgentAction(
  agentId: string,
  label = "Open assignee",
): IssueBoardState["primaryAction"] {
  return {
    type: "open_agent",
    label,
    targetEntity: "agent",
    targetId: agentId,
  };
}

function makeBlockerAction(blockerIssueId: string): IssueBoardState["primaryAction"] {
  return {
    type: "open_blocker",
    label: "Go to blocker",
    targetEntity: "issue",
    targetId: blockerIssueId,
  };
}

function blockedHeadline(blocker: { identifier: string | null; title: string }) {
  return `Blocked by ${blocker.identifier ?? blocker.title}`;
}

function redirectedHeadline(target: { identifier: string | null; title: string }) {
  return `Superseded by ${target.identifier ?? target.title}`;
}

function qaHeadline(agent: AgentSummary | null) {
  if (agent?.role === "qa") return "Waiting on QA";
  return "Waiting on review";
}

function assigneeHeadline(agent: AgentSummary | null) {
  if (agent?.name?.trim()) return `Waiting on ${agent.name.trim()}`;
  return "Waiting on assignee";
}

function executionCurrentParticipantType(executionState: Record<string, unknown> | null): "agent" | "user" | null {
  if (!executionState || typeof executionState !== "object") return null;
  const currentParticipant = executionState.currentParticipant;
  if (!currentParticipant || typeof currentParticipant !== "object") return null;
  const type = (currentParticipant as Record<string, unknown>).type;
  return type === "agent" || type === "user" ? type : null;
}

function executionCurrentParticipantId(executionState: Record<string, unknown> | null, type: "agent" | "user") {
  if (!executionState || typeof executionState !== "object") return null;
  const currentParticipant = executionState.currentParticipant;
  if (!currentParticipant || typeof currentParticipant !== "object") return null;
  const key = type === "agent" ? "agentId" : "userId";
  const value = (currentParticipant as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareRootCandidates(
  left: {
    blocker: RankedRootBlocker;
    updatedAtMs: number;
  },
  right: {
    blocker: RankedRootBlocker;
    updatedAtMs: number;
  },
) {
  if (left.blocker.blockedIssueCount !== right.blocker.blockedIssueCount) {
    return right.blocker.blockedIssueCount - left.blocker.blockedIssueCount;
  }
  if (priorityWeight(left.blocker.priority) !== priorityWeight(right.blocker.priority)) {
    return priorityWeight(right.blocker.priority) - priorityWeight(left.blocker.priority);
  }
  if (left.updatedAtMs !== right.updatedAtMs) {
    return left.updatedAtMs - right.updatedAtMs;
  }
  return (left.blocker.identifier ?? left.blocker.title).localeCompare(right.blocker.identifier ?? right.blocker.title);
}

type RankedRootBlocker = IssueRootBlocker & {
  priority: string;
};

function toPathNode(issue: IssueBoardStateRow): IssueBlockerPathNode {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status as IssueStatus,
    priority: issue.priority as IssueBlockerPathNode["priority"],
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
  };
}

function collectAncestorIds(
  startIssueIds: string[],
  blockersByIssueId: Map<string, string[]>,
) {
  const visited = new Set<string>();
  const queue = [...startIssueIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const blockers = blockersByIssueId.get(current) ?? [];
    for (const blockerId of blockers) {
      if (visited.has(blockerId)) continue;
      visited.add(blockerId);
      queue.push(blockerId);
    }
  }
  return visited;
}

function collectRootPaths(
  issueId: string,
  blockersByIssueId: Map<string, string[]>,
): RootPath[] {
  const results: RootPath[] = [];

  const visit = (currentIssueId: string, path: string[], seen: Set<string>) => {
    const blockers = blockersByIssueId.get(currentIssueId) ?? [];
    for (const blockerId of blockers) {
      if (seen.has(blockerId)) continue;
      const nextPath = [...path, blockerId];
      const blockerBlockers = blockersByIssueId.get(blockerId) ?? [];
      if (blockerBlockers.length === 0) {
        results.push({ rootId: blockerId, path: nextPath });
        continue;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(blockerId);
      visit(blockerId, nextPath, nextSeen);
    }
  };

  visit(issueId, [], new Set([issueId]));
  return results;
}

function createBlockedBoardState(primaryBlocker: IssuePrimaryBlocker): IssueBoardState {
  return {
    kind: "blocked",
    headline: blockedHeadline(primaryBlocker),
    reasonCode: null,
    actorType: "issue",
    actorId: primaryBlocker.issueId,
    primaryAction: makeBlockerAction(primaryBlocker.issueId),
  };
}

function createWaitingReviewBoardState(
  issueId: string,
  assignee: AgentSummary | null,
  currentParticipantType: "agent" | "user" | null,
  currentParticipantId: string | null,
): IssueBoardState {
  if (currentParticipantType === "user") {
    return {
      kind: "waiting",
      headline: "Waiting on board",
      reasonCode: "board_decision",
      actorType: "board",
      actorId: currentParticipantId,
      primaryAction: makeIssueAction(issueId, "Review decision"),
    };
  }
  return {
    kind: "waiting",
    headline: qaHeadline(assignee),
    reasonCode: "review",
    actorType: "agent",
    actorId: assignee?.id ?? currentParticipantId,
    primaryAction: makeIssueAction(issueId, assignee?.role === "qa" ? "Review QA state" : "Open review"),
  };
}

function createWaitingRecoveryBoardState(issueId: string): IssueBoardState {
  return {
    kind: "waiting",
    headline: "Waiting on recovery",
    reasonCode: "recovery",
    actorType: "system",
    actorId: issueId,
    primaryAction: makeIssueAction(issueId, "Review recovery state"),
  };
}

function createRedirectedBoardState(target: Pick<IssueBoardStateRow, "id" | "identifier" | "title">): IssueBoardState {
  return {
    kind: "redirected",
    headline: redirectedHeadline(target),
    reasonCode: "recovery",
    actorType: "issue",
    actorId: target.id,
    primaryAction: makeIssueAction(target.id, "Open successor"),
  };
}

function createWaitingAssigneeBoardState(issue: IssueBoardStateRow, assignee: AgentSummary | null): IssueBoardState {
  if (issue.assigneeAgentId) {
    return {
      kind: "waiting",
      headline: assigneeHeadline(assignee),
      reasonCode: "assignee_followup",
      actorType: "agent",
      actorId: issue.assigneeAgentId,
      primaryAction: makeAgentAction(issue.assigneeAgentId),
    };
  }
  if (issue.assigneeUserId) {
    return {
      kind: "waiting",
      headline: "Waiting on board",
      reasonCode: "board_decision",
      actorType: "board",
      actorId: issue.assigneeUserId,
      primaryAction: makeIssueAction(issue.id, "Review decision"),
    };
  }
  return {
    kind: "ready",
    headline: "Ready to assign",
    reasonCode: null,
    actorType: null,
    actorId: null,
    primaryAction: makeIssueAction(issue.id, "Open issue"),
  };
}

function createDoneBoardState(issue: IssueBoardStateRow): IssueBoardState {
  return {
    kind: "done",
    headline: issue.status === "cancelled" ? "Cancelled" : "Done",
    reasonCode: null,
    actorType: null,
    actorId: null,
    primaryAction: null,
  };
}

function createSystemErrorBoardState(issueId: string): IssueBoardState {
  return {
    kind: "system_error",
    headline: "System error in issue state",
    reasonCode: "invalid_state",
    actorType: "system",
    actorId: issueId,
    primaryAction: makeIssueAction(issueId, "Inspect issue state"),
  };
}

async function collectAncestorBlockRows(
  db: Db,
  companyId: string,
  startIssueIds: string[],
) {
  const rows: Array<{ blockerIssueId: string; blockedIssueId: string }> = [];
  const seenBlockedIssueIds = new Set<string>();
  const seenEdgeKeys = new Set<string>();
  let frontier = [...new Set(startIssueIds.filter(Boolean))];

  while (frontier.length > 0) {
    const blockedIssueIds = frontier.filter((issueId) => !seenBlockedIssueIds.has(issueId));
    if (blockedIssueIds.length === 0) break;
    blockedIssueIds.forEach((issueId) => seenBlockedIssueIds.add(issueId));

    const fetchedRows = await db
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, blockedIssueIds),
        ),
      );

    frontier = [];
    for (const row of fetchedRows) {
      const edgeKey = `${row.blockerIssueId}:${row.blockedIssueId}`;
      if (!seenEdgeKeys.has(edgeKey)) {
        rows.push(row);
        seenEdgeKeys.add(edgeKey);
      }
      if (!seenBlockedIssueIds.has(row.blockerIssueId)) {
        frontier.push(row.blockerIssueId);
      }
    }
  }

  return rows;
}

async function countUniqueDescendants(
  db: Db,
  companyId: string,
  rootIssueId: string,
  memo: Map<string, number>,
) {
  const cached = memo.get(rootIssueId);
  if (cached !== undefined) return cached;

  const seenDescendantIds = new Set<string>();
  const expandedBlockerIds = new Set<string>();
  let frontier = [rootIssueId];

  while (frontier.length > 0) {
    const blockerIssueIds = frontier.filter((issueId) => !expandedBlockerIds.has(issueId));
    if (blockerIssueIds.length === 0) break;
    blockerIssueIds.forEach((issueId) => expandedBlockerIds.add(issueId));

    const fetchedRows = await db
      .select({
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, blockerIssueIds),
        ),
      );

    frontier = [];
    for (const row of fetchedRows) {
      if (!seenDescendantIds.has(row.blockedIssueId)) {
        seenDescendantIds.add(row.blockedIssueId);
      }
      if (!expandedBlockerIds.has(row.blockedIssueId)) {
        frontier.push(row.blockedIssueId);
      }
    }
  }

  const count = seenDescendantIds.size;
  memo.set(rootIssueId, count);
  return count;
}

async function collectRecoveryDescendantRows(
  db: Db,
  companyId: string,
  startIssueIds: string[],
) {
  const rows: Array<{ sourceIssueId: string; successorIssueId: string }> = [];
  const seenSourceIssueIds = new Set<string>();
  const seenEdgeKeys = new Set<string>();
  let frontier = [...new Set(startIssueIds.filter(Boolean))];

  while (frontier.length > 0) {
    const sourceIssueIds = frontier.filter((issueId) => !seenSourceIssueIds.has(issueId));
    if (sourceIssueIds.length === 0) break;
    sourceIssueIds.forEach((issueId) => seenSourceIssueIds.add(issueId));

    const fetchedRows = await db
      .select({
        sourceIssueId: issueRelations.issueId,
        successorIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "recovered_by"),
          inArray(issueRelations.issueId, sourceIssueIds),
        ),
      );

    frontier = [];
    for (const row of fetchedRows) {
      const edgeKey = `${row.sourceIssueId}:${row.successorIssueId}`;
      if (!seenEdgeKeys.has(edgeKey)) {
        rows.push(row);
        seenEdgeKeys.add(edgeKey);
      }
      if (!seenSourceIssueIds.has(row.successorIssueId)) {
        frontier.push(row.successorIssueId);
      }
    }
  }

  return rows;
}

function resolveTerminalRecoveryTarget(
  issueId: string,
  recoverySuccessorsByIssueId: Map<string, string[]>,
  issueById: Map<string, IssueBoardStateRow>,
) {
  const directSuccessors = recoverySuccessorsByIssueId.get(issueId) ?? [];
  if (directSuccessors.length === 0) return null;

  const seen = new Set<string>([issueId]);
  let currentSuccessorId = directSuccessors[0] ?? null;
  let terminalTarget: IssueBoardStateRow | null = null;

  while (currentSuccessorId) {
    if (seen.has(currentSuccessorId)) return null;
    seen.add(currentSuccessorId);

    const currentSuccessor = issueById.get(currentSuccessorId);
    if (!currentSuccessor) return null;
    terminalTarget = currentSuccessor;

    const nextSuccessors = recoverySuccessorsByIssueId.get(currentSuccessorId) ?? [];
    currentSuccessorId = nextSuccessors[0] ?? null;
  }

  return terminalTarget;
}

export async function computeIssueBoardStateMap(
  db: Db,
  companyId: string,
  issueIds: string[],
  opts?: { includePaths?: boolean },
): Promise<Map<string, ComputedIssueBoardState>> {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const result = new Map<string, ComputedIssueBoardState>();
  if (uniqueIssueIds.length === 0) return result;

  const [blockRows, directRecoveryRows, recoveryDescendantRows] = await Promise.all([
    collectAncestorBlockRows(db, companyId, uniqueIssueIds),
    db
      .select({
        sourceIssueId: issueRelations.issueId,
        successorIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "recovered_by"),
          or(
            inArray(issueRelations.issueId, uniqueIssueIds),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      ),
    collectRecoveryDescendantRows(db, companyId, uniqueIssueIds),
  ]);

  const blockersByIssueId = new Map<string, string[]>();
  for (const row of blockRows) {
    const blockers = blockersByIssueId.get(row.blockedIssueId) ?? [];
    blockers.push(row.blockerIssueId);
    blockersByIssueId.set(row.blockedIssueId, blockers);
  }

  const ancestorIds = collectAncestorIds(uniqueIssueIds, blockersByIssueId);
  const recoveryDescendantIds = recoveryDescendantRows.map((row) => row.successorIssueId);
  const allRelevantIds = [...new Set([...uniqueIssueIds, ...ancestorIds, ...recoveryDescendantIds])];
  const issueRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, allRelevantIds)));

  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  const activeBlockersByIssueId = new Map<string, string[]>();
  for (const row of blockRows) {
    const blocker = issueById.get(row.blockerIssueId);
    if (!blocker || TERMINAL_ISSUE_STATUSES.has(blocker.status)) continue;
    const blockers = activeBlockersByIssueId.get(row.blockedIssueId) ?? [];
    blockers.push(row.blockerIssueId);
    activeBlockersByIssueId.set(row.blockedIssueId, blockers);
  }
  const assigneeAgentIds = [...new Set(
    issueRows
      .map((row) => row.assigneeAgentId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
  const agentRows = assigneeAgentIds.length === 0
    ? []
    : await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, assigneeAgentIds)));
  const agentById = new Map(agentRows.map((row) => [row.id, row]));

  const recoveryStateByIssueId = new Map<string, { hasRecoverySource: boolean; hasRecoverySuccessor: boolean }>();
  for (const issueId of uniqueIssueIds) {
    recoveryStateByIssueId.set(issueId, { hasRecoverySource: false, hasRecoverySuccessor: false });
  }
  for (const row of directRecoveryRows) {
    const source = recoveryStateByIssueId.get(row.sourceIssueId);
    if (source) source.hasRecoverySuccessor = true;
    const successor = recoveryStateByIssueId.get(row.successorIssueId);
    if (successor) successor.hasRecoverySource = true;
  }
  const recoverySuccessorsByIssueId = new Map<string, string[]>();
  for (const row of recoveryDescendantRows) {
    const existing = recoverySuccessorsByIssueId.get(row.sourceIssueId) ?? [];
    existing.push(row.successorIssueId);
    recoverySuccessorsByIssueId.set(row.sourceIssueId, existing);
  }

  const descendantCountMemo = new Map<string, number>();

  for (const issueId of uniqueIssueIds) {
    const issue = issueById.get(issueId);
    if (!issue) continue;

    const rootPaths = collectRootPaths(issueId, activeBlockersByIssueId);
    const pathByRootId = new Map<string, string[]>();
    for (const candidate of rootPaths) {
      const existing = pathByRootId.get(candidate.rootId);
      if (!existing || candidate.path.length < existing.length) {
        pathByRootId.set(candidate.rootId, candidate.path);
      }
    }

    const rankedRoots = [...pathByRootId.entries()]
      .map(([rootId, path]) => {
        const blocker = issueById.get(rootId);
        if (!blocker) return null;
        const rootBlocker: RankedRootBlocker = {
          issueId: blocker.id,
          identifier: blocker.identifier,
          title: blocker.title,
          blockedIssueCount: 0,
          pathLength: path.length,
          priority: blocker.priority,
        };
        return {
          blocker: rootBlocker,
          updatedAtMs: latestTimestampMs(blocker),
          path,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    await Promise.all(
      rankedRoots.map(async (candidate) => {
        candidate.blocker.blockedIssueCount = await countUniqueDescendants(
          db,
          companyId,
          candidate.blocker.issueId,
          descendantCountMemo,
        );
      }),
    );

    rankedRoots.sort(compareRootCandidates);

    const primaryRoot = rankedRoots[0] ?? null;
    const primaryBlocker = primaryRoot
      ? {
        issueId: primaryRoot.blocker.issueId,
        identifier: primaryRoot.blocker.identifier,
        title: primaryRoot.blocker.title,
        blockedIssueCount: primaryRoot.blocker.blockedIssueCount,
        pathLength: primaryRoot.blocker.pathLength,
      }
      : null;

    const currentParticipantType = executionCurrentParticipantType(issue.executionState);
    const currentParticipantId =
      currentParticipantType === "agent" || currentParticipantType === "user"
        ? executionCurrentParticipantId(issue.executionState, currentParticipantType)
        : null;
    const assignee = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? null : null;
    const hasBlockers = (activeBlockersByIssueId.get(issueId) ?? []).length > 0;
    const recoveryState = recoveryStateByIssueId.get(issueId) ?? {
      hasRecoverySource: false,
      hasRecoverySuccessor: false,
    };
    const recoveryRedirectTarget = recoveryState.hasRecoverySuccessor
      ? resolveTerminalRecoveryTarget(issueId, recoverySuccessorsByIssueId, issueById)
      : null;

    let boardState: IssueBoardState;
    if (recoveryRedirectTarget) {
      boardState = createRedirectedBoardState(recoveryRedirectTarget);
    } else if (issue.status === "done" || issue.status === "cancelled") {
      boardState = createDoneBoardState(issue);
    } else if (hasBlockers && primaryBlocker) {
      boardState = createBlockedBoardState(primaryBlocker);
    } else if (recoveryState.hasRecoverySuccessor) {
      boardState = createWaitingRecoveryBoardState(issue.id);
    } else if (issue.status === "blocked") {
      boardState = createSystemErrorBoardState(issue.id);
    } else if (issue.status === "in_review") {
      boardState = createWaitingReviewBoardState(issue.id, assignee, currentParticipantType, currentParticipantId);
    } else {
      boardState = createWaitingAssigneeBoardState(issue, assignee);
    }

    const blockerPath = opts?.includePaths && primaryRoot
      ? primaryRoot.path
        .map((pathIssueId) => issueById.get(pathIssueId))
        .filter((row): row is IssueBoardStateRow => Boolean(row))
        .map(toPathNode)
      : undefined;

    result.set(issueId, {
      boardState,
      primaryBlocker,
      rootBlockers: rankedRoots.map(({ blocker }) => ({
        issueId: blocker.issueId,
        identifier: blocker.identifier,
        title: blocker.title,
        blockedIssueCount: blocker.blockedIssueCount,
        pathLength: blocker.pathLength,
      })),
      ...(blockerPath ? { blockerPath } : {}),
    });
  }

  return result;
}
