import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { goals, issuePlanDecompositions, issueRelations, issues } from "@paperclipai/db";
import type {
  Goal,
  GoalMapDecompositionSummary,
  GoalMapEdge,
  GoalMapIssueEdge,
  GoalMapNode,
  GoalMapResponse,
  GoalMapRootIssue,
  GoalMapStatusCounts,
} from "@paperclipai/shared";

const MAX_ROOT_ISSUES_PER_GOAL = 100;
const MAX_DECOMPOSITIONS_PER_GOAL = 5;

function emptyStatusCounts(): GoalMapStatusCounts {
  return {
    total: 0,
    backlog: 0,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
  };
}

function addStatusCount(counts: GoalMapStatusCounts, status: string, amount: number) {
  counts.total += amount;
  switch (status) {
    case "backlog": counts.backlog += amount; break;
    case "todo": counts.todo += amount; break;
    case "in_progress": counts.inProgress += amount; break;
    case "in_review": counts.inReview += amount; break;
    case "done": counts.done += amount; break;
    case "blocked": counts.blocked += amount; break;
    case "cancelled": counts.cancelled += amount; break;
  }
}

function addCounts(target: GoalMapStatusCounts, source: GoalMapStatusCounts) {
  target.total += source.total;
  target.backlog += source.backlog;
  target.todo += source.todo;
  target.inProgress += source.inProgress;
  target.inReview += source.inReview;
  target.done += source.done;
  target.blocked += source.blocked;
  target.cancelled += source.cancelled;
}

export async function buildGoalMap(db: Db, companyId: string): Promise<GoalMapResponse> {
  const goalRows = await db
    .select()
    .from(goals)
    .where(eq(goals.companyId, companyId))
    .orderBy(asc(goals.createdAt), asc(goals.id));
  if (goalRows.length === 0) return { nodes: [], edges: [], issueEdges: [] };
  const goalIds = new Set(goalRows.map((goal) => goal.id));

  const statusCountRows = await db
    .select({
      goalId: issues.goalId,
      status: issues.status,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      isNull(issues.hiddenAt),
      sql`${issues.goalId} is not null`,
    ))
    .groupBy(issues.goalId, issues.status);

  const parentIssue = alias(issues, "goal_map_parent_issue");
  const rankedRootIssues = db
    .select({
      id: issues.id,
      goalId: issues.goalId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      rationale: issues.rationale,
      updatedAt: issues.updatedAt,
      rowNumber: sql<number>`row_number() over (
        partition by ${issues.goalId}
        order by
          case when ${issues.status} in ('done', 'cancelled') then 1 else 0 end,
          ${issues.createdAt} asc,
          ${issues.id} asc
      )`.as("goal_map_row_number"),
    })
    .from(issues)
    .leftJoin(parentIssue, eq(issues.parentId, parentIssue.id))
    .where(and(
      eq(issues.companyId, companyId),
      isNull(issues.hiddenAt),
      sql`${issues.goalId} is not null`,
      sql`(${issues.parentId} is null or ${parentIssue.goalId} is distinct from ${issues.goalId})`,
    ))
    .as("goal_map_root_issues");
  const rootIssueRows = await db
    .select({
      id: rankedRootIssues.id,
      goalId: rankedRootIssues.goalId,
      identifier: rankedRootIssues.identifier,
      title: rankedRootIssues.title,
      status: rankedRootIssues.status,
      priority: rankedRootIssues.priority,
      assigneeAgentId: rankedRootIssues.assigneeAgentId,
      rationale: rankedRootIssues.rationale,
      updatedAt: rankedRootIssues.updatedAt,
    })
    .from(rankedRootIssues)
    .where(lte(rankedRootIssues.rowNumber, MAX_ROOT_ISSUES_PER_GOAL + 1))
    .orderBy(asc(rankedRootIssues.rowNumber));

  const blockerIssue = alias(issues, "goal_map_blocker_issue");
  const blockedIssue = alias(issues, "goal_map_blocked_issue");
  const gateRows = await db
    .select({
      fromGoalId: blockerIssue.goalId,
      toGoalId: blockedIssue.goalId,
      totalIssueCount: sql<number>`count(*)::int`,
      openIssueCount: sql<number>`count(*) filter (
        where ${blockerIssue.status} not in ('done', 'cancelled')
      )::int`,
    })
    .from(issueRelations)
    .innerJoin(blockerIssue, eq(issueRelations.issueId, blockerIssue.id))
    .innerJoin(blockedIssue, eq(issueRelations.relatedIssueId, blockedIssue.id))
    .where(and(
      eq(issueRelations.companyId, companyId),
      eq(issueRelations.type, "blocks"),
      isNull(blockerIssue.hiddenAt),
      isNull(blockedIssue.hiddenAt),
      sql`${blockerIssue.goalId} is not null`,
      sql`${blockedIssue.goalId} is not null`,
      sql`${blockerIssue.goalId} is distinct from ${blockedIssue.goalId}`,
    ))
    .groupBy(blockerIssue.goalId, blockedIssue.goalId);

  const decompositionSourceIssue = alias(issues, "goal_map_decomposition_source");
  const decompositionRows = await db
    .select({
      goalId: decompositionSourceIssue.goalId,
      sourceIssueId: issuePlanDecompositions.sourceIssueId,
      sourceIssueIdentifier: decompositionSourceIssue.identifier,
      sourceIssueTitle: decompositionSourceIssue.title,
      status: issuePlanDecompositions.status,
      childCount: sql<number>`coalesce(jsonb_array_length(${issuePlanDecompositions.childIssueIds}), 0)::int`,
      ownerAgentId: issuePlanDecompositions.ownerAgentId,
      createdAt: issuePlanDecompositions.createdAt,
    })
    .from(issuePlanDecompositions)
    .innerJoin(decompositionSourceIssue, eq(issuePlanDecompositions.sourceIssueId, decompositionSourceIssue.id))
    .where(and(
      eq(issuePlanDecompositions.companyId, companyId),
      sql`${decompositionSourceIssue.goalId} is not null`,
    ))
    .orderBy(desc(issuePlanDecompositions.createdAt), desc(issuePlanDecompositions.id));

  const countsByGoalId = new Map<string, GoalMapStatusCounts>();
  for (const row of statusCountRows) {
    if (!row.goalId || !goalIds.has(row.goalId)) continue;
    const counts = countsByGoalId.get(row.goalId) ?? emptyStatusCounts();
    addStatusCount(counts, row.status, row.count);
    countsByGoalId.set(row.goalId, counts);
  }

  const rootIssueRowsByGoalId = new Map<string, typeof rootIssueRows>();
  const truncatedRootIssueGoalIds = new Set<string>();
  for (const row of rootIssueRows) {
    if (!row.goalId || !goalIds.has(row.goalId)) continue;
    const list = rootIssueRowsByGoalId.get(row.goalId) ?? [];
    if (list.length >= MAX_ROOT_ISSUES_PER_GOAL) {
      truncatedRootIssueGoalIds.add(row.goalId);
      continue;
    }
    list.push(row);
    rootIssueRowsByGoalId.set(row.goalId, list);
  }
  const keptRootIssueIds = [...rootIssueRowsByGoalId.values()].flat().map((row) => row.id);

  const childCountRows = keptRootIssueIds.length > 0
    ? await db
      .select({
        parentId: issues.parentId,
        status: issues.status,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        inArray(issues.parentId, keptRootIssueIds),
      ))
      .groupBy(issues.parentId, issues.status)
    : [];
  const childCountsByIssueId = new Map<string, { total: number; done: number }>();
  for (const row of childCountRows) {
    if (!row.parentId) continue;
    const counts = childCountsByIssueId.get(row.parentId) ?? { total: 0, done: 0 };
    if (row.status !== "cancelled") counts.total += row.count;
    if (row.status === "done") counts.done += row.count;
    childCountsByIssueId.set(row.parentId, counts);
  }

  // Blocks relations anywhere in the issue trees, rolled up to the displayed
  // root tasks that contain each endpoint — a subtask dependency still draws
  // an arrow between the two work streams it connects.
  const issueEdges: GoalMapIssueEdge[] = [];
  if (keptRootIssueIds.length > 0) {
    const keptRootIssueIdSet = new Set(keptRootIssueIds);
    const lineageRows = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        goalId: issues.goalId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)));
    const lineageById = new Map(lineageRows.map((row) => [row.id, row]));
    const rootMemo = new Map<string, string | null>();
    const rootIssueIdOf = (issueId: string): string | null => {
      const memoized = rootMemo.get(issueId);
      if (memoized !== undefined) return memoized;
      const seen = new Set<string>();
      let current = lineageById.get(issueId);
      if (!current) return null;
      while (
        current.parentId &&
        !seen.has(current.id) &&
        lineageById.get(current.parentId)?.goalId === current.goalId
      ) {
        seen.add(current.id);
        current = lineageById.get(current.parentId)!;
      }
      rootMemo.set(issueId, current.id);
      return current.id;
    };

    const relationRows = await db
      .select({
        fromIssueId: issueRelations.issueId,
        toIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
      ));
    const edgeByKey = new Map<string, GoalMapIssueEdge>();
    for (const row of relationRows) {
      const blocker = lineageById.get(row.fromIssueId);
      if (!blocker) continue;
      const fromRootId = rootIssueIdOf(row.fromIssueId);
      const toRootId = rootIssueIdOf(row.toIssueId);
      if (!fromRootId || !toRootId || fromRootId === toRootId) continue;
      if (!keptRootIssueIdSet.has(fromRootId) || !keptRootIssueIdSet.has(toRootId)) continue;
      const open = blocker.status !== "done" && blocker.status !== "cancelled";
      const key = `${fromRootId}->${toRootId}`;
      const existing = edgeByKey.get(key);
      if (existing) {
        existing.open = existing.open || open;
      } else {
        edgeByKey.set(key, { kind: "blocks", fromIssueId: fromRootId, toIssueId: toRootId, open });
      }
    }
    issueEdges.push(...edgeByKey.values());
  }

  const rootIssuesByGoalId = new Map<string, GoalMapRootIssue[]>();
  for (const [goalId, rows] of rootIssueRowsByGoalId) {
    rootIssuesByGoalId.set(goalId, rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status as GoalMapRootIssue["status"],
      priority: row.priority as GoalMapRootIssue["priority"],
      assigneeAgentId: row.assigneeAgentId,
      rationale: row.rationale,
      childTotalCount: childCountsByIssueId.get(row.id)?.total ?? 0,
      childDoneCount: childCountsByIssueId.get(row.id)?.done ?? 0,
      updatedAt: row.updatedAt,
    })));
  }

  const decompositionsByGoalId = new Map<string, GoalMapDecompositionSummary[]>();
  for (const row of decompositionRows) {
    if (!row.goalId || !goalIds.has(row.goalId)) continue;
    const list = decompositionsByGoalId.get(row.goalId) ?? [];
    if (list.length >= MAX_DECOMPOSITIONS_PER_GOAL) continue;
    list.push({
      sourceIssueId: row.sourceIssueId,
      sourceIssueIdentifier: row.sourceIssueIdentifier,
      sourceIssueTitle: row.sourceIssueTitle,
      status: row.status as GoalMapDecompositionSummary["status"],
      childCount: row.childCount,
      ownerAgentId: row.ownerAgentId,
      createdAt: row.createdAt,
    });
    decompositionsByGoalId.set(row.goalId, list);
  }

  // Subtree counts: aggregate each goal's direct counts into every ancestor.
  // Iterative parent walk with a visited guard so a cyclic parentId chain
  // cannot loop forever.
  const goalById = new Map(goalRows.map((goal) => [goal.id, goal]));
  const subtreeCountsByGoalId = new Map<string, GoalMapStatusCounts>();
  for (const goal of goalRows) subtreeCountsByGoalId.set(goal.id, emptyStatusCounts());
  for (const goal of goalRows) {
    const direct = countsByGoalId.get(goal.id);
    if (!direct || direct.total === 0) continue;
    const visited = new Set<string>();
    let current: typeof goal | undefined = goal;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      addCounts(subtreeCountsByGoalId.get(current.id)!, direct);
      current = current.parentId ? goalById.get(current.parentId) : undefined;
    }
  }

  const edges: GoalMapEdge[] = [];
  for (const goal of goalRows) {
    if (goal.parentId && goalIds.has(goal.parentId)) {
      edges.push({ kind: "parent", fromGoalId: goal.parentId, toGoalId: goal.id });
    }
  }
  const inboundOpenGatesByGoalId = new Map<string, number>();
  for (const row of gateRows) {
    if (!row.fromGoalId || !row.toGoalId) continue;
    if (!goalIds.has(row.fromGoalId) || !goalIds.has(row.toGoalId)) continue;
    edges.push({
      kind: "gates",
      fromGoalId: row.fromGoalId,
      toGoalId: row.toGoalId,
      openIssueCount: row.openIssueCount,
      totalIssueCount: row.totalIssueCount,
    });
    if (row.openIssueCount > 0) {
      inboundOpenGatesByGoalId.set(
        row.toGoalId,
        (inboundOpenGatesByGoalId.get(row.toGoalId) ?? 0) + row.openIssueCount,
      );
    }
  }

  const nodes: GoalMapNode[] = goalRows.map((goal) => {
    const inboundOpenGateCount = inboundOpenGatesByGoalId.get(goal.id) ?? 0;
    return {
      goal: goal as Goal,
      counts: countsByGoalId.get(goal.id) ?? emptyStatusCounts(),
      subtreeCounts: subtreeCountsByGoalId.get(goal.id) ?? emptyStatusCounts(),
      rootIssues: rootIssuesByGoalId.get(goal.id) ?? [],
      rootIssuesTruncated: truncatedRootIssueGoalIds.has(goal.id),
      decompositions: decompositionsByGoalId.get(goal.id) ?? [],
      inboundOpenGateCount,
      gated: inboundOpenGateCount > 0,
    };
  });

  return { nodes, edges, issueEdges };
}
