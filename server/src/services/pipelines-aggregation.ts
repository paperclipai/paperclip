import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  issues,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  routines,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

export const PIPELINE_ATTENTION_DEFAULT_LIMIT = 50;
export const PIPELINE_ATTENTION_MAX_LIMIT = 100;
export const COMPANY_CASE_EVENTS_DEFAULT_LIMIT = 50;
export const COMPANY_CASE_EVENTS_MAX_LIMIT = 100;
export const COMPANY_CASE_EVENTS_MAX_TYPES = 10;
export const CASE_CHILDREN_TREE_MAX_NODES = 1_000;
export const CASE_CHILDREN_TREE_MAX_DEPTH = 10;

export type AttentionCaller =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string };

type CaseRow = typeof pipelineCases.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;
type PipelineRow = typeof pipelines.$inferSelect;

export type ActiveWork = {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueRole: "work" | "automation";
  agentId: string;
  agentName: string;
  startedAt: Date | null;
};

function caseDisplay(row: { case: CaseRow; stage: StageRow; pipeline: PipelineRow }) {
  return {
    id: row.case.id,
    caseKey: row.case.caseKey,
    title: row.case.title,
    summary: row.case.summary,
    version: row.case.version,
    terminalKind: row.case.terminalKind,
    parentCaseId: row.case.parentCaseId,
    updatedAt: row.case.updatedAt,
    createdAt: row.case.createdAt,
    pipeline: { id: row.pipeline.id, key: row.pipeline.key, name: row.pipeline.name },
    stage: { id: row.stage.id, key: row.stage.key, name: row.stage.name, kind: row.stage.kind },
  };
}

// Review-stage approver semantics (B1 model): requireApproval=false awaits
// anyone; requireApproval=true awaits the configured approver (any_human,
// user, or a specific agent). Legacy rows may still store reviewerKind
// ("human"/"any") instead — honor it when present.
// SQL-side so busy companies can't truncate an agent's review feed.
function reviewStageAwaitsCallerSql(caller: AttentionCaller) {
  if (caller.type === "user") return sql`true`;
  return sql`(
    coalesce(${pipelineStages.config}->>'reviewerKind', '') = 'any'
    or (
      coalesce(${pipelineStages.config}->>'reviewerKind', '') <> 'human'
      and (
        coalesce((${pipelineStages.config}->>'requireApproval')::boolean, false) = false
        or (
          ${pipelineStages.config}->'approver'->>'kind' = 'agent'
          and ${pipelineStages.config}->'approver'->>'id' = ${caller.agentId}
        )
      )
    )
  )`;
}

function boundedLimit(limit: number | undefined, fallback: number, max: number) {
  return Math.min(max, Math.max(1, Math.floor(limit ?? fallback)));
}

function payloadString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function stageAutomationFromConfig(stage: typeof pipelineStages.$inferSelect) {
  const config = stage.config && typeof stage.config === "object" && !Array.isArray(stage.config)
    ? stage.config as Record<string, unknown>
    : {};
  const onEnter = config.onEnter && typeof config.onEnter === "object" && !Array.isArray(config.onEnter)
    ? config.onEnter as Record<string, unknown>
    : null;
  if (onEnter?.type !== "run_routine" || typeof onEnter.routineId !== "string" || !onEnter.routineId.trim()) {
    return null;
  }
  return {
    id: typeof onEnter.id === "string" && onEnter.id.trim() ? onEnter.id.trim() : `${stage.id}:on_enter`,
    routineId: onEnter.routineId.trim(),
  };
}

export async function listPipelineAttention(
  db: Db,
  input: { companyId: string; caller: AttentionCaller; limit?: number },
) {
  const limit = boundedLimit(input.limit, PIPELINE_ATTENTION_DEFAULT_LIMIT, PIPELINE_ATTENTION_MAX_LIMIT);

  const suggestionAgent = alias(agents, "suggestion_agent");
  const suggestionToStage = alias(pipelineStages, "suggestion_to_stage");
  const suggestionRows = await db
    .select({
      case: pipelineCases,
      pipeline: pipelines,
      stage: pipelineStages,
      toStage: suggestionToStage,
      suggestingAgent: { id: suggestionAgent.id, name: suggestionAgent.name },
    })
    .from(pipelineCases)
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .leftJoin(suggestionToStage, and(
      eq(suggestionToStage.pipelineId, pipelineCases.pipelineId),
      eq(suggestionToStage.key, sql`${pipelineCases.pendingSuggestion}->>'toStageKey'`),
    ))
    .leftJoin(suggestionAgent, sql`${suggestionAgent.id}::text = ${pipelineCases.pendingSuggestion}->>'suggestedByAgentId'`)
    .where(and(
      eq(pipelineCases.companyId, input.companyId),
      eq(pipelines.companyId, input.companyId),
      isNull(pipelineCases.terminalKind),
      isNotNull(pipelineCases.pendingSuggestion),
    ))
    .orderBy(desc(pipelineCases.updatedAt))
    .limit(limit);

  const suggestions = suggestionRows.map((row) => {
    const suggestion = row.case.pendingSuggestion!;
    return {
      case: caseDisplay(row),
      suggestion: {
        id: suggestion.id,
        fromStageKey: row.stage.key,
        fromStageName: row.stage.name,
        toStageKey: suggestion.toStageKey,
        toStageName: row.toStage?.name ?? null,
        rationale: suggestion.rationale,
        confidence: suggestion.confidence ?? null,
        createdAt: suggestion.createdAt,
        suggestedBy: row.suggestingAgent?.id
          ? { agentId: row.suggestingAgent.id, agentName: row.suggestingAgent.name }
          : null,
      },
    };
  });

  const reviewRows = await db
    .select({ case: pipelineCases, pipeline: pipelines, stage: pipelineStages })
    .from(pipelineCases)
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCases.companyId, input.companyId),
      eq(pipelines.companyId, input.companyId),
      eq(pipelineStages.kind, "review"),
      isNull(pipelineCases.terminalKind),
      reviewStageAwaitsCallerSql(input.caller),
    ))
    .orderBy(asc(pipelineCases.createdAt))
    .limit(limit);

  const reviews = reviewRows
    .map((row) => {
      const config = (row.stage.config ?? {}) as Record<string, unknown>;
      return {
        case: caseDisplay(row),
        review: {
          expectedVersion: row.case.version,
          approveToStageKey: typeof config.approveToStageKey === "string" ? config.approveToStageKey : null,
          rejectToStageKey: typeof config.rejectToStageKey === "string" ? config.rejectToStageKey : null,
          requestChangesToStageKey: typeof config.requestChangesToStageKey === "string" ? config.requestChangesToStageKey : null,
          requireRejectReason: config.requireRejectReason !== false,
          requireRequestChangesReason: config.requireRequestChangesReason !== false,
          reviewerKind:
            typeof config.reviewerKind === "string"
              ? config.reviewerKind
              : config.requireApproval === false
                ? "any"
                : "human",
        },
      };
    });

  const driftRows = await db
    .selectDistinctOn([pipelineCaseEvents.caseId], {
      event: pipelineCaseEvents,
      case: pipelineCases,
      pipeline: pipelines,
      stage: pipelineStages,
    })
    .from(pipelineCaseEvents)
    .innerJoin(pipelineCases, eq(pipelineCaseEvents.caseId, pipelineCases.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCaseEvents.companyId, input.companyId),
      eq(pipelineCaseEvents.type, "upstream_drift"),
      eq(pipelineCases.companyId, input.companyId),
      isNull(pipelineCases.terminalKind),
      sql`not exists (
        select 1
        from pipeline_case_events ack
        where ack.company_id = ${pipelineCaseEvents.companyId}
          and ack.case_id = ${pipelineCaseEvents.caseId}
          and ack.type = 'drift_acknowledged'
          and ack.created_at > ${pipelineCaseEvents.createdAt}
      )`,
    ))
    .orderBy(asc(pipelineCaseEvents.caseId), desc(pipelineCaseEvents.createdAt))
    .limit(limit);

  const driftCaseIds = driftRows.map((row) => row.case.id);
  const upstreamCaseIds = [...new Set(driftRows
    .map((row) => (row.event.payload as Record<string, unknown>).upstreamCaseId)
    .filter((value): value is string => typeof value === "string"))];

  const [activeWorkByCase, workIssuesByCase, upstreamCases] = await Promise.all([
    loadActiveWorkForCases(db, input.companyId, driftCaseIds),
    loadOpenWorkIssuesForCases(db, input.companyId, driftCaseIds),
    upstreamCaseIds.length === 0
      ? Promise.resolve([] as Array<{ case: CaseRow; pipeline: PipelineRow }>)
      : db
        .select({ case: pipelineCases, pipeline: pipelines })
        .from(pipelineCases)
        .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
        .where(and(eq(pipelineCases.companyId, input.companyId), inArray(pipelineCases.id, upstreamCaseIds))),
  ]);
  const upstreamById = new Map(upstreamCases.map((row) => [row.case.id, row]));

  const headsUp = driftRows.map((row) => {
    const payload = row.event.payload as Record<string, unknown>;
    const upstream = typeof payload.upstreamCaseId === "string" ? upstreamById.get(payload.upstreamCaseId) : undefined;
    return {
      case: caseDisplay(row),
      drift: {
        eventId: row.event.id,
        createdAt: row.event.createdAt,
        previousVersion: typeof payload.previousVersion === "number" ? payload.previousVersion : null,
        version: typeof payload.version === "number" ? payload.version : null,
        upstream: upstream
          ? {
            caseId: upstream.case.id,
            caseKey: upstream.case.caseKey,
            title: upstream.case.title,
            pipelineId: upstream.pipeline.id,
            pipelineName: upstream.pipeline.name,
          }
          : {
            caseId: typeof payload.upstreamCaseId === "string" ? payload.upstreamCaseId : null,
            caseKey: typeof payload.upstreamCaseKey === "string" ? payload.upstreamCaseKey : null,
            title: null,
            pipelineId: typeof payload.upstreamPipelineId === "string" ? payload.upstreamPipelineId : null,
            pipelineName: null,
          },
      },
      activeWork: activeWorkByCase.get(row.case.id) ?? null,
      workIssue: workIssuesByCase.get(row.case.id) ?? null,
    };
  });

  return {
    suggestions,
    reviews,
    headsUp,
    counts: { suggestions: suggestions.length, reviews: reviews.length, headsUp: headsUp.length },
  };
}

export async function listCompanyCaseEvents(
  db: Db,
  input: { companyId: string; types?: string[]; limit?: number; offset?: number },
) {
  const limit = boundedLimit(input.limit, COMPANY_CASE_EVENTS_DEFAULT_LIMIT, COMPANY_CASE_EVENTS_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const fromStage = alias(pipelineStages, "from_stage");
  const toStage = alias(pipelineStages, "to_stage");
  const actorAgent = alias(agents, "actor_agent");

  const rows = await db
    .select({
      event: pipelineCaseEvents,
      case: {
        id: pipelineCases.id,
        caseKey: pipelineCases.caseKey,
        title: pipelineCases.title,
        terminalKind: pipelineCases.terminalKind,
      },
      pipeline: { id: pipelines.id, key: pipelines.key, name: pipelines.name },
      fromStage: { id: fromStage.id, key: fromStage.key, name: fromStage.name, kind: fromStage.kind },
      toStage: { id: toStage.id, key: toStage.key, name: toStage.name, kind: toStage.kind },
      actorAgent: { id: actorAgent.id, name: actorAgent.name },
    })
    .from(pipelineCaseEvents)
    .innerJoin(pipelineCases, eq(pipelineCaseEvents.caseId, pipelineCases.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .leftJoin(fromStage, eq(pipelineCaseEvents.fromStageId, fromStage.id))
    .leftJoin(toStage, eq(pipelineCaseEvents.toStageId, toStage.id))
    .leftJoin(actorAgent, eq(pipelineCaseEvents.actorAgentId, actorAgent.id))
    .where(and(
      eq(pipelineCaseEvents.companyId, input.companyId),
      eq(pipelineCases.companyId, input.companyId),
      input.types && input.types.length > 0 ? inArray(pipelineCaseEvents.type, input.types) : undefined,
    ))
    .orderBy(desc(pipelineCaseEvents.createdAt), desc(pipelineCaseEvents.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const automationRows = pageRows.filter((row) =>
    row.event.type === "automation_executed" || row.event.type === "automation_failed"
  );
  const routineIds = [...new Set(automationRows
    .map((row) => payloadString(row.event.payload, "routineId"))
    .filter((id): id is string => Boolean(id)))];
  const issueIds = [...new Set(automationRows
    .map((row) => payloadString(row.event.payload, "issueId"))
    .filter((id): id is string => Boolean(id)))];
  const automationPipelineIds = [...new Set(automationRows.map((row) => row.pipeline.id))];
  const [routineRows, issueRowsForEvents, pipelineStageRows] = await Promise.all([
    routineIds.length > 0
      ? db
          .select({ id: routines.id, title: routines.title })
          .from(routines)
          .where(and(eq(routines.companyId, input.companyId), inArray(routines.id, routineIds)))
      : Promise.resolve([]),
    issueIds.length > 0
      ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIds)))
      : Promise.resolve([]),
    automationPipelineIds.length > 0
      ? db
          .select()
          .from(pipelineStages)
          .where(inArray(pipelineStages.pipelineId, automationPipelineIds))
      : Promise.resolve([]),
  ]);
  const routinesById = new Map(routineRows.map((routine) => [routine.id, routine]));
  const issuesById = new Map(issueRowsForEvents.map((issue) => [issue.id, issue]));
  const stagesByAutomationId = new Map<string, typeof pipelineStages.$inferSelect>();
  const stagesByRoutineId = new Map<string, typeof pipelineStages.$inferSelect>();
  for (const stage of pipelineStageRows) {
    const automation = stageAutomationFromConfig(stage);
    if (!automation) continue;
    stagesByAutomationId.set(automation.id, stage);
    stagesByRoutineId.set(automation.routineId, stage);
  }
  const items = pageRows.map((row) => {
    const routineId = payloadString(row.event.payload, "routineId");
    const issueId = payloadString(row.event.payload, "issueId");
    const automationId = payloadString(row.event.payload, "automationId");
    const automationStage = (
      (automationId ? stagesByAutomationId.get(automationId) : undefined) ??
      (routineId ? stagesByRoutineId.get(routineId) : undefined)
    );
    const routine = routineId ? routinesById.get(routineId) ?? null : null;
    const issue = issueId ? issuesById.get(issueId) ?? null : null;
    return {
      ...row.event,
      case: row.case,
      pipeline: row.pipeline,
      fromStage: row.fromStage?.id ? row.fromStage : null,
      toStage: row.toStage?.id ? row.toStage : null,
      actorAgent: row.actorAgent?.id ? row.actorAgent : null,
      automation: row.event.type === "automation_executed" || row.event.type === "automation_failed"
        ? {
            routine: routine ? { id: routine.id, title: routine.title } : null,
            issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status } : null,
            routineRunId: payloadString(row.event.payload, "routineRunId"),
            stage: automationStage
              ? { id: automationStage.id, key: automationStage.key, name: automationStage.name, kind: automationStage.kind }
              : null,
          }
        : undefined,
    };
  });

  return {
    items,
    pagination: { limit, offset, nextOffset: hasMore ? offset + limit : null, hasMore },
  };
}

export type CaseChildrenRollup = { total: number; done: number; dropped: number; inMotion: number };

type SubtreeRow = {
  id: string;
  parent_case_id: string | null;
  pipeline_id: string;
  stage_id: string;
  case_key: string;
  title: string;
  terminal_kind: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  depth: number;
};

export type CaseChildNode = {
  id: string;
  caseKey: string;
  title: string;
  terminalKind: string | null;
  createdAt: Date;
  updatedAt: Date;
  pipeline: { id: string; key: string; name: string };
  stage: { id: string; key: string; name: string; kind: string };
  rollup: CaseChildrenRollup;
  childGroups: Array<{ pipeline: { id: string; key: string; name: string }; cases: CaseChildNode[] }>;
};

export async function getCaseChildrenTree(db: Db, companyId: string, caseId: string) {
  const result = await db.execute(sql`
    with recursive subtree as (
      select id, parent_case_id, pipeline_id, stage_id, case_key, title, terminal_kind, created_at, updated_at, 0 as depth
      from pipeline_cases
      where company_id = ${companyId} and id = ${caseId}
      union all
      select child.id, child.parent_case_id, child.pipeline_id, child.stage_id, child.case_key, child.title,
             child.terminal_kind, child.created_at, child.updated_at, parent.depth + 1
      from pipeline_cases child
      join subtree parent on child.parent_case_id = parent.id
      where child.company_id = ${companyId}
        and child.hidden_from_board_at is null
        and parent.depth < ${CASE_CHILDREN_TREE_MAX_DEPTH}
    )
    select * from subtree limit ${CASE_CHILDREN_TREE_MAX_NODES + 1}
  `);
  const rows = Array.from(result) as SubtreeRow[];
  if (rows.length === 0) throw notFound("Pipeline case not found");
  const truncated = rows.length > CASE_CHILDREN_TREE_MAX_NODES;
  const bounded = truncated ? rows.slice(0, CASE_CHILDREN_TREE_MAX_NODES) : rows;

  const pipelineIds = [...new Set(bounded.map((row) => row.pipeline_id))];
  const stageIds = [...new Set(bounded.map((row) => row.stage_id))];
  const [pipelineRows, stageRows] = await Promise.all([
    db.select({ id: pipelines.id, key: pipelines.key, name: pipelines.name })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, companyId), inArray(pipelines.id, pipelineIds))),
    db.select({ id: pipelineStages.id, key: pipelineStages.key, name: pipelineStages.name, kind: pipelineStages.kind })
      .from(pipelineStages)
      .where(inArray(pipelineStages.id, stageIds)),
  ]);
  const pipelineById = new Map(pipelineRows.map((row) => [row.id, row]));
  const stageById = new Map(stageRows.map((row) => [row.id, row]));

  const nodeById = new Map<string, CaseChildNode>();
  const childRowsByParent = new Map<string, SubtreeRow[]>();
  for (const row of bounded) {
    if (row.id !== caseId && row.parent_case_id) {
      const list = childRowsByParent.get(row.parent_case_id) ?? [];
      list.push(row);
      childRowsByParent.set(row.parent_case_id, list);
    }
  }

  function buildNode(row: SubtreeRow): CaseChildNode {
    const childRows = (childRowsByParent.get(row.id) ?? [])
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const children = childRows.map(buildNode);
    const rollup: CaseChildrenRollup = { total: 0, done: 0, dropped: 0, inMotion: 0 };
    for (const child of children) {
      rollup.total += 1 + child.rollup.total;
      rollup.done += (child.terminalKind === "done" ? 1 : 0) + child.rollup.done;
      rollup.dropped += (child.terminalKind === "cancelled" ? 1 : 0) + child.rollup.dropped;
      rollup.inMotion += (child.terminalKind === null ? 1 : 0) + child.rollup.inMotion;
    }
    const pipeline = pipelineById.get(row.pipeline_id) ?? { id: row.pipeline_id, key: "", name: "" };
    const groups = new Map<string, { pipeline: { id: string; key: string; name: string }; cases: CaseChildNode[] }>();
    for (const child of children) {
      const group = groups.get(child.pipeline.id) ?? { pipeline: child.pipeline, cases: [] };
      group.cases.push(child);
      groups.set(child.pipeline.id, group);
    }
    const childGroups = [...groups.values()].sort((a, b) => {
      if (a.pipeline.id === row.pipeline_id && b.pipeline.id !== row.pipeline_id) return -1;
      if (b.pipeline.id === row.pipeline_id && a.pipeline.id !== row.pipeline_id) return 1;
      return a.pipeline.name.localeCompare(b.pipeline.name);
    });
    const node: CaseChildNode = {
      id: row.id,
      caseKey: row.case_key,
      title: row.title,
      terminalKind: row.terminal_kind,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      pipeline,
      stage: stageById.get(row.stage_id) ?? { id: row.stage_id, key: "", name: "", kind: "" },
      rollup,
      childGroups,
    };
    nodeById.set(row.id, node);
    return node;
  }

  const rootRow = bounded.find((row) => row.id === caseId);
  if (!rootRow) throw notFound("Pipeline case not found");
  const root = buildNode(rootRow);

  return {
    case: root,
    rollup: root.rollup,
    childGroups: root.childGroups,
    truncated,
    totalNodes: bounded.length,
  };
}

export async function getDirectChildrenSummary(
  db: Db,
  companyId: string,
  caseId: string,
): Promise<CaseChildrenRollup> {
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${pipelineCases.terminalKind} = 'done')::int`,
      dropped: sql<number>`count(*) filter (where ${pipelineCases.terminalKind} = 'cancelled')::int`,
      inMotion: sql<number>`count(*) filter (where ${pipelineCases.terminalKind} is null)::int`,
    })
    .from(pipelineCases)
    .where(and(
      eq(pipelineCases.companyId, companyId),
      eq(pipelineCases.parentCaseId, caseId),
      isNull(pipelineCases.hiddenFromBoardAt),
    ));
  return counts ?? { total: 0, done: 0, dropped: 0, inMotion: 0 };
}

export async function loadActiveWorkForCases(
  db: Db,
  companyId: string,
  caseIds: string[],
): Promise<Map<string, ActiveWork | null>> {
  const map = new Map<string, ActiveWork | null>(caseIds.map((id) => [id, null]));
  if (caseIds.length === 0) return map;
  const rows = await db
    .select({
      caseId: pipelineCaseIssueLinks.caseId,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      issueRole: pipelineCaseIssueLinks.role,
      agentId: issues.assigneeAgentId,
      agentName: agents.name,
      startedAt: issues.startedAt,
      issueUpdatedAt: issues.updatedAt,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
    .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      inArray(pipelineCaseIssueLinks.caseId, caseIds),
      inArray(pipelineCaseIssueLinks.role, ["work", "automation"]),
      eq(issues.companyId, companyId),
      eq(issues.status, "in_progress"),
      isNull(issues.hiddenAt),
    ))
    .orderBy(desc(issues.updatedAt));
  for (const row of rows) {
    if (map.get(row.caseId)) continue;
    map.set(row.caseId, {
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      issueTitle: row.issueTitle,
      issueRole: row.issueRole as "work" | "automation",
      agentId: row.agentId!,
      agentName: row.agentName,
      startedAt: row.startedAt ?? row.issueUpdatedAt,
    });
  }
  return map;
}

type DescendantActiveWorkCountRow = {
  root_id: string;
  count: number;
};

export async function loadDescendantActiveWorkCountsForCases(
  db: Db,
  companyId: string,
  caseIds: string[],
): Promise<Map<string, number>> {
  const uniqueCaseIds = [...new Set(caseIds)];
  const map = new Map<string, number>(uniqueCaseIds.map((id) => [id, 0]));
  if (uniqueCaseIds.length === 0) return map;

  const rootValues = sql.join(uniqueCaseIds.map((id) => sql`(${id}::uuid)`), sql`, `);
  const rows = Array.from(await db.execute(sql`
    with recursive roots(root_id) as (
      values ${rootValues}
    ),
    subtree(root_id, id, depth) as (
      select roots.root_id, roots.root_id, 0
      from roots
      join pipeline_cases root_case
        on root_case.id = roots.root_id
       and root_case.company_id = ${companyId}
      union all
      select subtree.root_id, child.id, subtree.depth + 1
      from pipeline_cases child
      join subtree on child.parent_case_id = subtree.id
      where child.company_id = ${companyId}
        and child.hidden_from_board_at is null
        and subtree.depth < ${CASE_CHILDREN_TREE_MAX_DEPTH}
    )
    select subtree.root_id, count(distinct subtree.id)::int as count
    from subtree
    join pipeline_case_issue_links link
      on link.company_id = ${companyId}
     and link.case_id = subtree.id
     and link.role in ('work', 'automation')
    join issues issue
      on issue.id = link.issue_id
     and issue.company_id = ${companyId}
     and issue.status = 'in_progress'
     and issue.hidden_at is null
    join agents agent on agent.id = issue.assignee_agent_id
    where subtree.depth > 0
    group by subtree.root_id
  `)) as DescendantActiveWorkCountRow[];

  for (const row of rows) {
    map.set(row.root_id, row.count);
  }
  return map;
}

type PipelineDescendantActiveWorkCountRow = {
  pipeline_id: string;
  count: number;
};

export async function loadPipelineDescendantActiveWorkCounts(
  db: Db,
  companyId: string,
  pipelineIds: string[],
): Promise<Map<string, number>> {
  const uniquePipelineIds = [...new Set(pipelineIds)];
  const map = new Map<string, number>(uniquePipelineIds.map((id) => [id, 0]));
  if (uniquePipelineIds.length === 0) return map;

  const pipelineValues = sql.join(uniquePipelineIds.map((id) => sql`(${id}::uuid)`), sql`, `);
  const rows = Array.from(await db.execute(sql`
    with recursive target_pipelines(pipeline_id) as (
      values ${pipelineValues}
    ),
    roots(root_pipeline_id, root_case_id) as (
      select target_pipelines.pipeline_id, root_case.id
      from target_pipelines
      join pipeline_cases root_case
        on root_case.pipeline_id = target_pipelines.pipeline_id
       and root_case.company_id = ${companyId}
    ),
    subtree(root_pipeline_id, root_case_id, id, depth) as (
      select roots.root_pipeline_id, roots.root_case_id, roots.root_case_id, 0
      from roots
      union all
      select subtree.root_pipeline_id, subtree.root_case_id, child.id, subtree.depth + 1
      from pipeline_cases child
      join subtree on child.parent_case_id = subtree.id
      where child.company_id = ${companyId}
        and child.hidden_from_board_at is null
        and subtree.depth < ${CASE_CHILDREN_TREE_MAX_DEPTH}
    )
    select subtree.root_pipeline_id as pipeline_id, count(distinct subtree.id)::int as count
    from subtree
    join pipeline_case_issue_links link
      on link.company_id = ${companyId}
     and link.case_id = subtree.id
     and link.role in ('work', 'automation')
    join issues issue
      on issue.id = link.issue_id
     and issue.company_id = ${companyId}
     and issue.status = 'in_progress'
     and issue.hidden_at is null
    join agents agent on agent.id = issue.assignee_agent_id
    where subtree.depth > 0
    group by subtree.root_pipeline_id
  `)) as PipelineDescendantActiveWorkCountRow[];

  for (const row of rows) {
    map.set(row.pipeline_id, row.count);
  }
  return map;
}

async function loadOpenWorkIssuesForCases(db: Db, companyId: string, caseIds: string[]) {
  const map = new Map<string, { issueId: string; issueIdentifier: string | null; title: string; status: string }>();
  if (caseIds.length === 0) return map;
  const rows = await db
    .select({
      caseId: pipelineCaseIssueLinks.caseId,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      inArray(pipelineCaseIssueLinks.caseId, caseIds),
      eq(pipelineCaseIssueLinks.role, "work"),
      eq(issues.companyId, companyId),
      ne(issues.status, "done"),
      ne(issues.status, "cancelled"),
      isNull(issues.hiddenAt),
    ))
    .orderBy(desc(issues.updatedAt));
  for (const row of rows) {
    if (map.has(row.caseId)) continue;
    map.set(row.caseId, {
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      title: row.title,
      status: row.status,
    });
  }
  return map;
}

export type PipelineConnections = { upstreamPipelineIds: string[]; downstreamPipelineIds: string[] };

export async function loadPipelineConnections(
  db: Db,
  companyId: string,
): Promise<Map<string, PipelineConnections>> {
  const parentCase = alias(pipelineCases, "parent_case");
  const rows = await db
    .selectDistinct({
      parentPipelineId: parentCase.pipelineId,
      childPipelineId: pipelineCases.pipelineId,
    })
    .from(pipelineCases)
    .innerJoin(parentCase, eq(pipelineCases.parentCaseId, parentCase.id))
    .where(and(
      eq(pipelineCases.companyId, companyId),
      eq(parentCase.companyId, companyId),
      ne(pipelineCases.pipelineId, parentCase.pipelineId),
    ));
  const map = new Map<string, PipelineConnections>();
  const entry = (pipelineId: string) => {
    let value = map.get(pipelineId);
    if (!value) {
      value = { upstreamPipelineIds: [], downstreamPipelineIds: [] };
      map.set(pipelineId, value);
    }
    return value;
  };
  for (const row of rows) {
    entry(row.childPipelineId).upstreamPipelineIds.push(row.parentPipelineId);
    entry(row.parentPipelineId).downstreamPipelineIds.push(row.childPipelineId);
  }
  for (const value of map.values()) {
    value.upstreamPipelineIds.sort();
    value.downstreamPipelineIds.sort();
  }
  return map;
}
