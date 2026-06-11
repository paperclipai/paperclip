import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  routines,
} from "@paperclipai/db";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { routineService } from "./routines.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_CASE_KEY_LENGTH = 1024;
const MAX_BATCH_INGEST = 200;
const MAX_FIELDS_BYTES = 64 * 1024;
export const PIPELINE_CASE_EVENTS_DEFAULT_LIMIT = 50;
export const PIPELINE_CASE_EVENTS_MAX_LIMIT = 100;
export const PIPELINE_CONTEXT_PACK_EVENT_LIMIT = 20;

const DEFAULT_STAGES = [
  { key: "intake", name: "Intake", kind: "open", position: 100 },
  { key: "in_progress", name: "In progress", kind: "working", position: 200 },
  {
    key: "review",
    name: "Review",
    kind: "review",
    position: 300,
    config: { approveToStageKey: "done", rejectToStageKey: "cancelled", requireRejectReason: true, reviewerKind: "human" },
  },
  { key: "done", name: "Done", kind: "done", position: 900 },
  { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
] as const;

export type PipelineActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId: string }
  | { type: "system" };

export type PipelineStageKind = "open" | "working" | "review" | "done" | "cancelled";

export type PipelineStageConfig = Record<string, unknown> & {
  autonomy?: "manual" | "suggest" | "auto";
  autoAdvanceOnChildrenTerminal?: string;
  approveToStageKey?: string;
  rejectToStageKey?: string;
  requestChangesToStageKey?: string;
  requireRejectReason?: boolean;
  reviewerKind?: "human" | "any";
  onEnter?: {
    type?: "run_routine";
    routineId?: string;
    id?: string;
  };
};

export type PipelineReviewDecision = "approve" | "reject" | "request_changes";

export type PipelineAutomationExecutionResult =
  | { status: "none" }
  | { status: "succeeded"; execution: typeof pipelineAutomationExecutions.$inferSelect }
  | { status: "failed"; execution: typeof pipelineAutomationExecutions.$inferSelect };

type PipelineDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function nowDate() {
  return new Date();
}

function eventActorPatch(actor: PipelineActor) {
  if (actor.type === "agent") {
    assertActorProvenance(actor);
    return { actorType: "agent", actorAgentId: actor.agentId, runId: actor.runId };
  }
  if (actor.type === "user") {
    return { actorType: "user", actorUserId: actor.userId };
  }
  return { actorType: "system" };
}

function assertActorProvenance(actor: PipelineActor) {
  if (actor.type === "agent" && !actor.runId) {
    throw unprocessable("Agent pipeline mutations require a run id", { code: "run_id_required" });
  }
}

function assertCaseKey(caseKey: string) {
  if (caseKey.length > MAX_CASE_KEY_LENGTH) {
    throw unprocessable("caseKey must be at most 1024 characters", { code: "validation" });
  }
}

function assertJsonSize(value: unknown, label: string) {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  if (bytes > MAX_FIELDS_BYTES) {
    throw unprocessable(`${label} must be at most 64KB`, { code: "validation" });
  }
}

function isTerminalKind(kind: string | null | undefined) {
  return kind === "done" || kind === "cancelled";
}

function terminalKindForStage(kind: string) {
  return isTerminalKind(kind) ? kind : null;
}

function hasValidLease(row: typeof pipelineCases.$inferSelect, now = nowDate()) {
  return Boolean(row.leaseToken && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime());
}

function leaseOwner(row: typeof pipelineCases.$inferSelect) {
  if (row.leaseOwnerType === "agent") {
    return { type: "agent", agentId: row.leaseAgentId, expiresAt: row.leaseExpiresAt };
  }
  if (row.leaseOwnerType === "user") {
    return { type: "user", userId: row.leaseUserId, expiresAt: row.leaseExpiresAt };
  }
  return { type: row.leaseOwnerType, expiresAt: row.leaseExpiresAt };
}

function actorOwnsLease(row: typeof pipelineCases.$inferSelect, actor: PipelineActor, leaseToken?: string | null) {
  if (!row.leaseToken) return true;
  if (leaseToken && leaseToken === row.leaseToken) return true;
  if (actor.type === "agent") return row.leaseOwnerType === "agent" && row.leaseAgentId === actor.agentId;
  if (actor.type === "user") return row.leaseOwnerType === "user" && row.leaseUserId === actor.userId;
  return false;
}

function conflictDetailsForCase(row: typeof pipelineCases.$inferSelect, stage?: typeof pipelineStages.$inferSelect | null) {
  return {
    code: "version_conflict",
    version: row.version,
    stage: stage ? { id: stage.id, key: stage.key, kind: stage.kind } : { id: row.stageId },
  };
}

function stageConfig(stage: typeof pipelineStages.$inferSelect): PipelineStageConfig {
  return (stage.config ?? {}) as PipelineStageConfig;
}

function normalizeStageConfig(kind: PipelineStageKind | string, config?: PipelineStageConfig | null): PipelineStageConfig {
  const next = { ...(config ?? {}) };
  if (kind !== "review") return next;

  if (typeof next.approveToStageKey !== "string" || next.approveToStageKey.trim().length === 0) {
    throw unprocessable("Review stages require approveToStageKey", { code: "validation" });
  }
  if (typeof next.rejectToStageKey !== "string" || next.rejectToStageKey.trim().length === 0) {
    throw unprocessable("Review stages require rejectToStageKey", { code: "validation" });
  }
  if (
    next.requestChangesToStageKey !== undefined &&
    (typeof next.requestChangesToStageKey !== "string" || next.requestChangesToStageKey.trim().length === 0)
  ) {
    throw unprocessable("Review stage requestChangesToStageKey must be a non-empty string", { code: "validation" });
  }
  if (next.requireRejectReason !== undefined && typeof next.requireRejectReason !== "boolean") {
    throw unprocessable("Review stage requireRejectReason must be boolean", { code: "validation" });
  }
  if (next.reviewerKind !== undefined && next.reviewerKind !== "human" && next.reviewerKind !== "any") {
    throw unprocessable("Review stage reviewerKind must be human or any", { code: "validation" });
  }

  return {
    ...next,
    approveToStageKey: next.approveToStageKey.trim(),
    rejectToStageKey: next.rejectToStageKey.trim(),
    ...(next.requestChangesToStageKey !== undefined ? { requestChangesToStageKey: next.requestChangesToStageKey.trim() } : {}),
    requireRejectReason: next.requireRejectReason ?? true,
    reviewerKind: next.reviewerKind ?? "human",
  };
}

function reviewConfigForStage(stage: typeof pipelineStages.$inferSelect) {
  return normalizeStageConfig(stage.kind, stageConfig(stage));
}

function assertReviewTargetsInSet(
  kind: PipelineStageKind | string,
  config: PipelineStageConfig,
  stageKeys: Set<string>,
) {
  if (kind !== "review") return;
  if (!stageKeys.has(config.approveToStageKey!)) {
    throw unprocessable("Review approveToStageKey references an unknown stage", { code: "validation" });
  }
  if (!stageKeys.has(config.rejectToStageKey!)) {
    throw unprocessable("Review rejectToStageKey references an unknown stage", { code: "validation" });
  }
  if (config.requestChangesToStageKey !== undefined && !stageKeys.has(config.requestChangesToStageKey)) {
    throw unprocessable("Review requestChangesToStageKey references an unknown stage", { code: "validation" });
  }
}

function targetStageKeyForReviewDecision(config: PipelineStageConfig, decision: PipelineReviewDecision) {
  if (decision === "approve") return config.approveToStageKey!;
  if (decision === "reject") return config.rejectToStageKey!;
  if (!config.requestChangesToStageKey) {
    throw unprocessable("Review stage does not configure requestChangesToStageKey", { code: "validation" });
  }
  return config.requestChangesToStageKey;
}

function stageAutomation(stage: typeof pipelineStages.$inferSelect) {
  const onEnter = stageConfig(stage).onEnter;
  if (!onEnter || onEnter.type !== "run_routine" || !onEnter.routineId) return null;
  return {
    id: onEnter.id ?? `${stage.id}:on_enter`,
    routineId: onEnter.routineId,
  };
}

function buildCaseDeepLink(input: { pipelineId: string; caseId: string }) {
  return `/PAP/pipelines/${input.pipelineId}/cases/${input.caseId}`;
}

function buildPipelineCaseContextPack(input: {
  pipeline: typeof pipelines.$inferSelect;
  case: typeof pipelineCases.$inferSelect;
  stage: typeof pipelineStages.$inferSelect;
}) {
  return {
    pipeline: {
      id: input.pipeline.id,
      key: input.pipeline.key,
      name: input.pipeline.name,
    },
    case: {
      id: input.case.id,
      caseKey: input.case.caseKey,
      title: input.case.title,
      version: input.case.version,
      deepLink: buildCaseDeepLink({ pipelineId: input.pipeline.id, caseId: input.case.id }),
      untrustedContent: {
        summary: input.case.summary,
        fields: input.case.fields,
      },
    },
    stage: {
      id: input.stage.id,
      key: input.stage.key,
      name: input.stage.name,
      kind: input.stage.kind,
    },
  };
}

function buildPipelineCaseContextMarkdown(input: {
  pipeline: typeof pipelines.$inferSelect;
  case: typeof pipelineCases.$inferSelect;
  stage: typeof pipelineStages.$inferSelect;
  triggeringEventId?: string | null;
}) {
  const contextPack = buildPipelineCaseContextPack(input);
  return [
    "## Pipeline Case Context",
    "",
    `Case: ${input.case.title}`,
    `Pipeline: ${input.pipeline.name} (${input.pipeline.key})`,
    `Stage: ${input.stage.name} (${input.stage.key}, ${input.stage.kind})`,
    `Case link: ${contextPack.case.deepLink}`,
    input.triggeringEventId ? `Triggering event: ${input.triggeringEventId}` : null,
    "",
    "```json",
    JSON.stringify(contextPack, null, 2),
    "```",
  ].filter((line): line is string => line !== null).join("\n");
}

async function writeCaseEvent(
  db: PipelineDb,
  input: {
    companyId: string;
    caseId: string;
    type: string;
    actor: PipelineActor;
    fromStageId?: string | null;
    toStageId?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  const [event] = await db
    .insert(pipelineCaseEvents)
    .values({
      companyId: input.companyId,
      caseId: input.caseId,
      type: input.type,
      ...eventActorPatch(input.actor),
      fromStageId: input.fromStageId ?? null,
      toStageId: input.toStageId ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  return event!;
}

async function getPipelineOrThrow(db: PipelineDb, companyId: string, pipelineId: string) {
  const row = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline not found");
  return row;
}

async function getStageOrThrow(db: PipelineDb, pipelineId: string, stageId: string) {
  const row = await db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline stage not found");
  return row;
}

async function getStageByKeyOrThrow(db: PipelineDb, pipelineId: string, key: string) {
  const row = await db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, key)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline stage not found");
  return row;
}

async function getCaseWithStageOrThrow(db: PipelineDb, companyId: string, caseId: string) {
  const row = await db
    .select({ case: pipelineCases, stage: pipelineStages, pipeline: pipelines })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId), eq(pipelines.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  return row;
}

async function expireLeaseIfNeeded(db: PipelineDb, row: typeof pipelineCases.$inferSelect, actor: PipelineActor) {
  const now = nowDate();
  if (!row.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() > now.getTime()) {
    return row;
  }

  const [updated] = await db
    .update(pipelineCases)
    .set({
      leaseOwnerType: null,
      leaseAgentId: null,
      leaseUserId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(pipelineCases.id, row.id), eq(pipelineCases.leaseToken, row.leaseToken)))
    .returning();
  if (!updated) return row;

  await writeCaseEvent(db, {
    companyId: row.companyId,
    caseId: row.id,
    type: "lease_expired",
    actor,
    payload: { previousOwner: leaseOwner(row), expiredAt: now.toISOString() },
  });
  return updated;
}

async function assertLeaseAvailable(
  db: PipelineDb,
  row: typeof pipelineCases.$inferSelect,
  actor: PipelineActor,
  leaseToken?: string | null,
) {
  const current = await expireLeaseIfNeeded(db, row, { type: "system" });
  if (hasValidLease(current) && !actorOwnsLease(current, actor, leaseToken)) {
    throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
  }
  return current;
}

async function assertNoOpenBlockers(db: PipelineDb, row: typeof pipelineCases.$inferSelect, toStage: typeof pipelineStages.$inferSelect) {
  if (toStage.kind !== "working" && toStage.kind !== "done") return;
  const blockers = await db
    .select({
      id: pipelineCases.id,
      caseKey: pipelineCases.caseKey,
      title: pipelineCases.title,
      terminalKind: pipelineCases.terminalKind,
    })
    .from(pipelineCaseBlockers)
    .innerJoin(pipelineCases, eq(pipelineCaseBlockers.blockedByCaseId, pipelineCases.id))
    .where(
      and(
        eq(pipelineCaseBlockers.companyId, row.companyId),
        eq(pipelineCaseBlockers.caseId, row.id),
        or(isNull(pipelineCases.terminalKind), ne(pipelineCases.terminalKind, "done")),
      ),
    );
  if (blockers.length > 0) {
    throw conflict("Pipeline case is blocked", { code: "blocked", blockers });
  }
}

async function getCaseOrThrow(db: PipelineDb, companyId: string, caseId: string) {
  const row = await db
    .select()
    .from(pipelineCases)
    .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  return row;
}

async function assertValidParentCase(
  db: PipelineDb,
  input: { companyId: string; caseId?: string | null; parentCaseId?: string | null },
) {
  if (!input.parentCaseId) return null;
  if (input.caseId && input.parentCaseId === input.caseId) {
    throw conflict("Pipeline case parent cycle detected", { code: "parent_cycle" });
  }

  let current = await getCaseOrThrow(db, input.companyId, input.parentCaseId);
  let depth = 1;
  while (current.parentCaseId) {
    if (input.caseId && current.parentCaseId === input.caseId) {
      throw conflict("Pipeline case parent cycle detected", { code: "parent_cycle" });
    }
    if (depth >= 32) {
      throw unprocessable("Pipeline case parent depth exceeds 32", { code: "parent_depth_exceeded" });
    }
    current = await getCaseOrThrow(db, input.companyId, current.parentCaseId);
    depth += 1;
  }
  if (depth >= 32) {
    throw unprocessable("Pipeline case parent depth exceeds 32", { code: "parent_depth_exceeded" });
  }
  return input.parentCaseId;
}

async function adjustParentCounts(
  db: PipelineDb,
  input: { parentCaseId: string | null | undefined; childDelta?: number; terminalChildDelta?: number },
) {
  if (!input.parentCaseId) return;
  const patch: Partial<typeof pipelineCases.$inferInsert> = { updatedAt: nowDate() };
  if (input.childDelta) {
    patch.childCount = sql`${pipelineCases.childCount} + ${input.childDelta}` as unknown as number;
  }
  if (input.terminalChildDelta) {
    patch.terminalChildCount = sql`${pipelineCases.terminalChildCount} + ${input.terminalChildDelta}` as unknown as number;
  }
  if (!input.childDelta && !input.terminalChildDelta) return;
  await db.update(pipelineCases).set(patch).where(eq(pipelineCases.id, input.parentCaseId));
}

async function computeCaseRollup(db: PipelineDb, companyId: string, caseId: string) {
  const rows = await db.execute(sql<{
    id: string;
    terminal_kind: string | null;
  }>`
    with recursive subtree as (
      select id, terminal_kind from pipeline_cases where company_id = ${companyId} and id = ${caseId}
      union all
      select child.id, child.terminal_kind
      from pipeline_cases child
      join subtree parent on child.parent_case_id = parent.id
      where child.company_id = ${companyId}
    )
    select id, terminal_kind from subtree
  `);
  const items = Array.from(rows);
  if (items.length === 0) throw notFound("Pipeline case not found");
  const descendants = items.slice(1);
  const done = descendants.filter((item) => item.terminal_kind === "done").length;
  const cancelled = descendants.filter((item) => item.terminal_kind === "cancelled").length;
  const open = descendants.filter((item) => item.terminal_kind !== "done" && item.terminal_kind !== "cancelled").length;
  return { total: descendants.length, done, cancelled, open, complete: open === 0 };
}

async function hasCaseEvent(db: PipelineDb, caseId: string, type: string) {
  const row = await db
    .select({ id: pipelineCaseEvents.id })
    .from(pipelineCaseEvents)
    .where(and(eq(pipelineCaseEvents.caseId, caseId), eq(pipelineCaseEvents.type, type)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

async function postSystemCommentOnLinkedIssues(
  db: PipelineDb,
  input: {
    companyId: string;
    caseId: string;
    roles: Array<"origin" | "conversation" | "work" | "automation">;
    body: string;
  },
) {
  const rows = await db
    .select({ issueId: issues.id })
    .from(pipelineCaseIssueLinks)
    .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, input.companyId),
      eq(pipelineCaseIssueLinks.caseId, input.caseId),
      inArray(pipelineCaseIssueLinks.role, input.roles),
      ne(issues.status, "done"),
      ne(issues.status, "cancelled"),
      isNull(issues.hiddenAt),
    ));

  for (const row of rows) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: row.issueId,
      authorType: "system",
      body: input.body,
    });
    await db.update(issues).set({ updatedAt: nowDate() }).where(eq(issues.id, row.issueId));
  }
}

async function getAncestorCases(db: PipelineDb, companyId: string, parentCaseId: string | null | undefined) {
  const ancestors: Array<{
    case: typeof pipelineCases.$inferSelect;
    stage: typeof pipelineStages.$inferSelect;
  }> = [];
  let nextId = parentCaseId ?? null;
  let depth = 0;
  while (nextId) {
    if (depth >= 32) break;
    const row = await getCaseWithStageOrThrow(db, companyId, nextId);
    ancestors.push(row);
    nextId = row.case.parentCaseId;
    depth += 1;
  }
  return ancestors;
}

async function handleBlockersResolved(db: PipelineDb, companyId: string, blockerCaseId: string) {
  const blockedRows = await db
    .select({ caseId: pipelineCaseBlockers.caseId })
    .from(pipelineCaseBlockers)
    .where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.blockedByCaseId, blockerCaseId)));

  for (const blocked of blockedRows) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pipelineCaseBlockers)
      .innerJoin(pipelineCases, eq(pipelineCaseBlockers.blockedByCaseId, pipelineCases.id))
      .where(and(
        eq(pipelineCaseBlockers.companyId, companyId),
        eq(pipelineCaseBlockers.caseId, blocked.caseId),
        or(isNull(pipelineCases.terminalKind), ne(pipelineCases.terminalKind, "done")),
      ));
    if ((count ?? 0) > 0 || await hasCaseEvent(db, blocked.caseId, "blockers_resolved")) continue;
    await writeCaseEvent(db, {
      companyId,
      caseId: blocked.caseId,
      type: "blockers_resolved",
      actor: { type: "system" },
      payload: { resolvedByCaseId: blockerCaseId },
    });
    await postSystemCommentOnLinkedIssues(db, {
      companyId,
      caseId: blocked.caseId,
      roles: ["work"],
      body: `Pipeline blockers resolved for case ${blocked.caseId}. The case can be retried now that blocker ${blockerCaseId} is done.`,
    });
  }
}

async function notifyDependentWorkIssuesOfUpstreamContentChange(
  db: PipelineDb,
  input: {
    companyId: string;
    upstreamCase: typeof pipelineCases.$inferSelect;
    previousVersion: number;
    version: number;
  },
) {
  const rows = await db
    .selectDistinctOn([issues.id], { issueId: issues.id })
    .from(pipelineCaseBlockers)
    .innerJoin(pipelineCases, eq(pipelineCaseBlockers.caseId, pipelineCases.id))
    .innerJoin(pipelineCaseIssueLinks, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
    .where(and(
      eq(pipelineCaseBlockers.companyId, input.companyId),
      eq(pipelineCaseBlockers.blockedByCaseId, input.upstreamCase.id),
      eq(pipelineCases.companyId, input.companyId),
      isNull(pipelineCases.terminalKind),
      eq(pipelineCaseIssueLinks.companyId, input.companyId),
      eq(pipelineCaseIssueLinks.role, "work"),
      eq(issues.companyId, input.companyId),
      ne(issues.status, "done"),
      ne(issues.status, "cancelled"),
      isNull(issues.hiddenAt),
    ));

  if (rows.length === 0) return;

  const upstreamLink = buildCaseDeepLink({
    pipelineId: input.upstreamCase.pipelineId,
    caseId: input.upstreamCase.id,
  });
  const body = `Upstream case [${input.upstreamCase.caseKey}](${upstreamLink}) changed (v${input.previousVersion}→v${input.version}).`;

  for (const row of rows) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: row.issueId,
      authorType: "system",
      body,
    });
    await db.update(issues).set({ updatedAt: nowDate() }).where(eq(issues.id, row.issueId));
  }
}

async function validateBlockerSet(
  db: PipelineDb,
  input: { companyId: string; caseId: string; blockedByCaseIds: string[] },
) {
  const uniqueBlockerIds = [...new Set(input.blockedByCaseIds)];
  if (uniqueBlockerIds.length !== input.blockedByCaseIds.length) {
    throw unprocessable("Pipeline blocker set contains duplicate cases", { code: "validation" });
  }
  if (uniqueBlockerIds.includes(input.caseId)) {
    throw conflict("Pipeline case cannot block itself", { code: "blocker_cycle" });
  }
  if (uniqueBlockerIds.length === 0) return uniqueBlockerIds;

  const rows = await db
    .select({ id: pipelineCases.id })
    .from(pipelineCases)
    .where(and(eq(pipelineCases.companyId, input.companyId), inArray(pipelineCases.id, uniqueBlockerIds)));
  if (rows.length !== uniqueBlockerIds.length) throw notFound("Pipeline blocker case not found");

  const stack = [...uniqueBlockerIds];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === input.caseId) {
      throw conflict("Pipeline blocker cycle detected", { code: "blocker_cycle" });
    }
    if (seen.has(current)) continue;
    seen.add(current);
    const next = await db
      .select({ blockedByCaseId: pipelineCaseBlockers.blockedByCaseId })
      .from(pipelineCaseBlockers)
      .where(and(eq(pipelineCaseBlockers.companyId, input.companyId), eq(pipelineCaseBlockers.caseId, current)));
    stack.push(...next.map((row) => row.blockedByCaseId));
  }

  return uniqueBlockerIds;
}

async function resolveBlockerCaseKeys(
  db: PipelineDb,
  input: { companyId: string; pipelineId: string; blockedByCaseKeys: string[] },
) {
  const uniqueKeys = [...new Set(input.blockedByCaseKeys)];
  if (uniqueKeys.length !== input.blockedByCaseKeys.length) {
    throw unprocessable("Pipeline blocker key set contains duplicate cases", { code: "validation" });
  }
  for (const key of uniqueKeys) assertCaseKey(key);
  if (uniqueKeys.length === 0) return new Map<string, string>();

  const rows = await db
    .select({ id: pipelineCases.id, caseKey: pipelineCases.caseKey })
    .from(pipelineCases)
    .where(and(
      eq(pipelineCases.companyId, input.companyId),
      eq(pipelineCases.pipelineId, input.pipelineId),
      inArray(pipelineCases.caseKey, uniqueKeys),
    ));
  if (rows.length !== uniqueKeys.length) {
    throw new HttpError(404, "Pipeline blocker case key not found", {
      code: "blocker_case_key_not_found",
      missingCaseKeys: uniqueKeys.filter((key) => !rows.some((row) => row.caseKey === key)),
    });
  }
  return new Map(rows.map((row) => [row.caseKey, row.id]));
}

function pipelineBatchError(error: unknown, fallbackCode = "unknown") {
  const httpError = error as { status?: number; message?: string; details?: unknown };
  return {
    status: httpError.status ?? 500,
    message: httpError.message ?? "Unknown error",
    details: httpError.details ?? { code: fallbackCode },
  };
}

async function enqueueStageAutomationLedger(
  db: PipelineDb,
  input: {
    companyId: string;
    caseId: string;
    stage: typeof pipelineStages.$inferSelect;
    eventId: string;
  },
) {
  const automation = stageAutomation(input.stage);
  if (!automation) return null;
  const [ledger] = await db
    .insert(pipelineAutomationExecutions)
    .values({
      companyId: input.companyId,
      caseId: input.caseId,
      automationId: automation.id,
      triggeringEventId: input.eventId,
      routineId: automation.routineId,
      status: "failed",
      error: "pending_dispatch",
    })
    .onConflictDoNothing({
      target: [
        pipelineAutomationExecutions.caseId,
        pipelineAutomationExecutions.automationId,
        pipelineAutomationExecutions.triggeringEventId,
      ],
    })
    .returning();
  return ledger ?? null;
}

export function pipelineService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const routinesSvc = routineService(db, { heartbeat: deps.heartbeat });

  async function assertRoutineInCompany(companyId: string, routineId: string) {
    const routine = await db
      .select({ id: routines.id, companyId: routines.companyId, assigneeAgentId: routines.assigneeAgentId })
      .from(routines)
      .where(eq(routines.id, routineId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) {
      throw unprocessable("Pipeline automation routine must belong to the same company", { code: "validation" });
    }
    return routine;
  }

  async function validateStageAutomationConfig(companyId: string, config?: PipelineStageConfig | null) {
    const onEnter = config?.onEnter;
    if (!onEnter || onEnter.type !== "run_routine" || !onEnter.routineId) return;
    await assertRoutineInCompany(companyId, onEnter.routineId);
  }

  async function validateStageTargets(companyId: string, pipelineId: string, kind: PipelineStageKind | string, config: PipelineStageConfig) {
    if (kind !== "review") return;
    const rows = await db
      .select({ key: pipelineStages.key })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelines.companyId, companyId)));
    assertReviewTargetsInSet(kind, config, new Set(rows.map((row) => row.key)));
  }

  async function executeAutomationLedger(
    executionId: string,
    actor: PipelineActor = { type: "system" },
  ): Promise<PipelineAutomationExecutionResult> {
    const execution = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.id, executionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!execution) throw notFound("Pipeline automation execution not found");
    if (execution.status === "succeeded" && execution.executionIssueId) {
      return { status: "succeeded", execution };
    }

    const detail = await getCaseWithStageOrThrow(db, execution.companyId, execution.caseId);
    const automation = stageAutomation(detail.stage);
    if (!automation || automation.id !== execution.automationId) {
      const [failed] = await db
        .update(pipelineAutomationExecutions)
        .set({ status: "failed", error: "automation_not_configured", updatedAt: nowDate() })
        .where(eq(pipelineAutomationExecutions.id, execution.id))
        .returning();
      await writeCaseEvent(db, {
        companyId: execution.companyId,
        caseId: execution.caseId,
        type: "automation_failed",
        actor,
        payload: { automationId: execution.automationId, error: "automation_not_configured" },
      });
      return { status: "failed", execution: failed! };
    }

    try {
      const routine = await assertRoutineInCompany(execution.companyId, execution.routineId);
      const contextPack = buildPipelineCaseContextPack(detail);
      const run = await routinesSvc.runPipelineStageEntryRoutine(execution.routineId, {
        source: "api",
        assigneeAgentId: routine.assigneeAgentId,
        idempotencyKey: `pipeline:${execution.caseId}:${execution.automationId}:${execution.triggeringEventId}`,
        payload: {
          pipeline: contextPack.pipeline,
          case: contextPack.case,
          stage: contextPack.stage,
          triggeringEventId: execution.triggeringEventId,
          contextPack,
        },
        descriptionAppendix: buildPipelineCaseContextMarkdown({
          ...detail,
          triggeringEventId: execution.triggeringEventId,
        }),
      });
      if (!run.linkedIssueId) {
        throw new Error(`Routine run ${run.id} did not create or coalesce an execution issue`);
      }
      const [updated] = await db
        .update(pipelineAutomationExecutions)
        .set({
          status: "succeeded",
          executionIssueId: run.linkedIssueId,
          error: null,
          updatedAt: nowDate(),
        })
        .where(eq(pipelineAutomationExecutions.id, execution.id))
        .returning();
      await db
        .insert(pipelineCaseIssueLinks)
        .values({
          companyId: execution.companyId,
          caseId: execution.caseId,
          issueId: run.linkedIssueId,
          role: "automation",
          createdByRunId: null,
        })
        .onConflictDoNothing({ target: [pipelineCaseIssueLinks.caseId, pipelineCaseIssueLinks.issueId] });
      await writeCaseEvent(db, {
        companyId: execution.companyId,
        caseId: execution.caseId,
        type: "automation_executed",
        actor,
        payload: {
          automationId: execution.automationId,
          routineId: execution.routineId,
          routineRunId: run.id,
          issueId: run.linkedIssueId,
          status: run.status,
        },
      });
      return { status: "succeeded", execution: updated! };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [failed] = await db
        .update(pipelineAutomationExecutions)
        .set({ status: "failed", error: message, updatedAt: nowDate() })
        .where(eq(pipelineAutomationExecutions.id, execution.id))
        .returning();
      await writeCaseEvent(db, {
        companyId: execution.companyId,
        caseId: execution.caseId,
        type: "automation_failed",
        actor,
        payload: { automationId: execution.automationId, routineId: execution.routineId, error: message },
      });
      return { status: "failed", execution: failed! };
    }
  }

  async function patchCaseContentInTransaction(
    tx: PipelineDb,
    input: {
      companyId: string;
      caseId: string;
      title?: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      parentCaseId?: string | null;
      expectedVersion?: number;
      leaseToken?: string | null;
      actor: PipelineActor;
    },
  ) {
    if (input.fields !== undefined) assertJsonSize(input.fields, "fields");
    const { case: existing, stage } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
    const current = await assertLeaseAvailable(tx, existing, input.actor, input.leaseToken);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(current, stage));
    }
    if (input.parentCaseId !== undefined) {
      await assertValidParentCase(tx, {
        companyId: input.companyId,
        caseId: current.id,
        parentCaseId: input.parentCaseId,
      });
    }
    const titleChanged = input.title !== undefined && input.title !== current.title;
    const summaryChanged = input.summary !== undefined && input.summary !== current.summary;
    const fieldsChanged = input.fields !== undefined && !isDeepStrictEqual(input.fields, current.fields);
    const parentCaseChanged = input.parentCaseId !== undefined && input.parentCaseId !== current.parentCaseId;
    const contentChanged = titleChanged || summaryChanged || fieldsChanged;
    if (!contentChanged && !parentCaseChanged) {
      return { case: current, event: null };
    }

    const patch: Partial<typeof pipelineCases.$inferInsert> = {
      version: current.version + 1,
      updatedAt: nowDate(),
    };
    if (titleChanged) patch.title = input.title;
    if (summaryChanged) patch.summary = input.summary;
    if (fieldsChanged) patch.fields = input.fields;
    if (parentCaseChanged) patch.parentCaseId = input.parentCaseId;

    const [updated] = await tx
      .update(pipelineCases)
      .set(patch)
      .where(and(eq(pipelineCases.id, current.id), eq(pipelineCases.version, current.version)))
      .returning();
    if (!updated) {
      const latest = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(latest.case, latest.stage));
    }

    const event = await writeCaseEvent(tx, {
      companyId: input.companyId,
      caseId: updated.id,
      type: "updated",
      actor: input.actor,
      payload: {
        previousVersion: current.version,
        version: updated.version,
        parentCaseChanged,
      },
    });
    if (parentCaseChanged) {
      const terminalDelta = isTerminalKind(current.terminalKind) ? 1 : 0;
      await adjustParentCounts(tx, {
        parentCaseId: current.parentCaseId,
        childDelta: -1,
        terminalChildDelta: -terminalDelta,
      });
      await adjustParentCounts(tx, {
        parentCaseId: input.parentCaseId,
        childDelta: 1,
        terminalChildDelta: terminalDelta,
      });
      if (isTerminalKind(current.terminalKind)) {
        await handleChildrenTerminal(tx, input.companyId, input.parentCaseId);
      }
    }
    if (contentChanged) {
      await notifyDependentWorkIssuesOfUpstreamContentChange(tx, {
        companyId: input.companyId,
        upstreamCase: updated,
        previousVersion: current.version,
        version: updated.version,
      });
    }
    return { case: updated, event };
  }

  async function transitionCaseInTransaction(
    tx: PipelineDb,
    input: {
      companyId: string;
      caseId: string;
      toStageId?: string;
      toStageKey?: string;
      expectedVersion: number;
      leaseToken?: string | null;
      actor: PipelineActor;
      transitionClass?: "manual" | "suggested" | "auto";
      suggestionId?: string;
      reason?: string | null;
    },
  ) {
    if (input.transitionClass === "auto") {
      throw unprocessable("Pipeline auto autonomy is not enabled", { code: "autonomy_not_enabled" });
    }
    const { case: existing, stage: fromStage, pipeline } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
    if (pipeline.archivedAt) throw unprocessable("Pipeline is archived", { code: "pipeline_archived" });
    const current = await assertLeaseAvailable(tx, existing, input.actor, input.leaseToken);
    if (current.version !== input.expectedVersion) {
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(current, fromStage));
    }
    if (fromStage.kind === "review" && input.actor.type === "agent") {
      const config = stageConfig(fromStage);
      if (config.reviewerKind !== "any") {
        throw new HttpError(403, "Human review is required", { code: "review_required" });
      }
    }

    const toStage = input.toStageId
      ? await getStageOrThrow(tx, current.pipelineId, input.toStageId)
      : await getStageByKeyOrThrow(tx, current.pipelineId, input.toStageKey ?? "");
    const toConfig = stageConfig(toStage);
    if (toConfig.autonomy === "auto") {
      throw unprocessable("Pipeline auto autonomy is not enabled", { code: "autonomy_not_enabled" });
    }
    if (pipeline.enforceTransitions && fromStage.id !== toStage.id) {
      const allowed = await tx
        .select({ id: pipelineTransitions.id })
        .from(pipelineTransitions)
        .where(
          and(
            eq(pipelineTransitions.pipelineId, current.pipelineId),
            eq(pipelineTransitions.fromStageId, fromStage.id),
            eq(pipelineTransitions.toStageId, toStage.id),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!allowed) {
        throw conflict("Pipeline transition is not allowed", { code: "transition_not_allowed" });
      }
    }
    await assertNoOpenBlockers(tx, current, toStage);

    const enteringTerminal = terminalKindForStage(toStage.kind);
    const [updated] = await tx
      .update(pipelineCases)
      .set({
        stageId: toStage.id,
        version: current.version + 1,
        terminalKind: enteringTerminal,
        terminalAt: enteringTerminal ? nowDate() : null,
        pendingSuggestion: input.suggestionId === current.pendingSuggestion?.id ? null : current.pendingSuggestion,
        leaseOwnerType: enteringTerminal ? null : current.leaseOwnerType,
        leaseAgentId: enteringTerminal ? null : current.leaseAgentId,
        leaseUserId: enteringTerminal ? null : current.leaseUserId,
        leaseToken: enteringTerminal ? null : current.leaseToken,
        leaseExpiresAt: enteringTerminal ? null : current.leaseExpiresAt,
        updatedAt: nowDate(),
      })
      .where(and(eq(pipelineCases.id, current.id), eq(pipelineCases.version, current.version)))
      .returning();
    if (!updated) {
      const latest = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(latest.case, latest.stage));
    }

    const event = await writeCaseEvent(tx, {
      companyId: input.companyId,
      caseId: current.id,
      type: "transitioned",
      actor: input.actor,
      fromStageId: fromStage.id,
      toStageId: toStage.id,
      payload: {
        previousVersion: current.version,
        version: updated.version,
        suggestionId: input.suggestionId ?? null,
        reason: input.reason ?? null,
        transitionClass: input.transitionClass ?? "manual",
      },
    });
    const ledger = await enqueueStageAutomationLedger(tx, {
      companyId: input.companyId,
      caseId: current.id,
      stage: toStage,
      eventId: event.id,
    });
    const wasTerminal = isTerminalKind(current.terminalKind);
    const isTerminal = isTerminalKind(updated.terminalKind);
    if (current.parentCaseId && wasTerminal !== isTerminal) {
      await adjustParentCounts(tx, {
        parentCaseId: current.parentCaseId,
        terminalChildDelta: isTerminal ? 1 : -1,
      });
    }
    if (!wasTerminal && updated.terminalKind === "done") {
      await handleBlockersResolved(tx, input.companyId, current.id);
    }
    if (!wasTerminal && isTerminal) {
      await handleChildrenTerminal(tx, input.companyId, current.parentCaseId);
    }
    return { case: updated, event, automationLedger: ledger };
  }

  async function handleChildrenTerminal(tx: PipelineDb, companyId: string, parentCaseId: string | null | undefined) {
    const ancestors = await getAncestorCases(tx, companyId, parentCaseId);
    for (const ancestor of ancestors) {
      const rollup = await computeCaseRollup(tx, companyId, ancestor.case.id);
      if (!rollup.complete || rollup.total === 0 || await hasCaseEvent(tx, ancestor.case.id, "children_terminal")) {
        continue;
      }
      await writeCaseEvent(tx, {
        companyId,
        caseId: ancestor.case.id,
        type: "children_terminal",
        actor: { type: "system" },
        payload: { rollup },
      });
      await postSystemCommentOnLinkedIssues(tx, {
        companyId,
        caseId: ancestor.case.id,
        roles: ["origin", "conversation"],
        body: `All child cases for pipeline case "${ancestor.case.title}" are terminal. Rollup: ${rollup.done} done, ${rollup.cancelled} cancelled, ${rollup.open} open.`,
      });

      const toStageKey = stageConfig(ancestor.stage).autoAdvanceOnChildrenTerminal;
      if (typeof toStageKey !== "string" || !toStageKey || isTerminalKind(ancestor.case.terminalKind)) {
        continue;
      }
      const toStage = await getStageByKeyOrThrow(tx, ancestor.case.pipelineId, toStageKey);
      if (toStage.id === ancestor.stage.id) continue;
      await transitionCaseInTransaction(tx, {
        companyId,
        caseId: ancestor.case.id,
        toStageKey,
        expectedVersion: ancestor.case.version,
        actor: { type: "system" },
        reason: "children_terminal",
      });
    }
  }

  const service = {
    async createPipeline(input: {
      companyId: string;
      key: string;
      name: string;
      description?: string | null;
      projectId?: string | null;
      enforceTransitions?: boolean;
      stages?: Array<{ key: string; name: string; kind: PipelineStageKind; position?: number; config?: PipelineStageConfig }>;
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        const stageInputs = input.stages?.length
          ? input.stages.map((stage, index) => ({
            ...stage,
            position: stage.position ?? (index + 1) * 100,
            config: normalizeStageConfig(stage.kind, stage.config),
          }))
          : DEFAULT_STAGES.map((stage) => ({
            ...stage,
            config: normalizeStageConfig(stage.kind, "config" in stage ? stage.config : {}),
          }));
        const stageKeys = new Set(stageInputs.map((stage) => stage.key));
        for (const stage of stageInputs) {
          assertReviewTargetsInSet(stage.kind, stage.config, stageKeys);
          await validateStageAutomationConfig(input.companyId, stage.config);
        }
        const [pipeline] = await tx
          .insert(pipelines)
          .values({
            companyId: input.companyId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            projectId: input.projectId ?? null,
            enforceTransitions: input.enforceTransitions ?? false,
            createdByUserId: input.actor.type === "user" ? input.actor.userId : null,
            createdByAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
          })
          .returning();
        const insertedStages = await tx
          .insert(pipelineStages)
          .values(stageInputs.map((stage) => ({
            pipelineId: pipeline!.id,
            key: stage.key,
            name: stage.name,
            kind: stage.kind,
            position: stage.position,
            config: stage.config ?? {},
          })))
          .returning();

        if (!insertedStages.some((stage) => stage.kind === "done") || !insertedStages.some((stage) => stage.kind === "cancelled")) {
          throw unprocessable("Pipeline must include at least one done stage and one cancelled stage", { code: "validation" });
        }

        if (!input.stages?.length) {
          const byKey = new Map(insertedStages.map((stage) => [stage.key, stage]));
          const edges = [
            ["intake", "in_progress"],
            ["in_progress", "review"],
            ["review", "done"],
          ] as const;
          await tx.insert(pipelineTransitions).values(edges.map(([from, to]) => ({
            pipelineId: pipeline!.id,
            fromStageId: byKey.get(from)!.id,
            toStageId: byKey.get(to)!.id,
          })));
        }

        return { ...pipeline!, stages: insertedStages };
      });
    },

    async listStages(companyId: string, pipelineId: string) {
      await getPipelineOrThrow(db, companyId, pipelineId);
      return db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipelineId))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt));
    },

    async createStage(input: {
      companyId: string;
      pipelineId: string;
      key: string;
      name: string;
      kind: PipelineStageKind;
      position: number;
      config?: PipelineStageConfig;
    }) {
      await getPipelineOrThrow(db, input.companyId, input.pipelineId);
      const config = normalizeStageConfig(input.kind, input.config);
      await validateStageTargets(input.companyId, input.pipelineId, input.kind, config);
      await validateStageAutomationConfig(input.companyId, config);
      const [stage] = await db
        .insert(pipelineStages)
        .values({
          pipelineId: input.pipelineId,
          key: input.key,
          name: input.name,
          kind: input.kind,
          position: input.position,
          config,
        })
        .returning();
      return stage!;
    },

    async updateStage(input: {
      companyId: string;
      pipelineId: string;
      stageId: string;
      patch: {
        key?: string;
        name?: string;
        kind?: PipelineStageKind;
        position?: number;
        config?: PipelineStageConfig;
      };
    }) {
      await getPipelineOrThrow(db, input.companyId, input.pipelineId);
      const existing = await getStageOrThrow(db, input.pipelineId, input.stageId);
      const kind = input.patch.kind ?? existing.kind;
      const config = normalizeStageConfig(kind, input.patch.config !== undefined ? input.patch.config : stageConfig(existing));
      await validateStageTargets(input.companyId, input.pipelineId, kind, config);
      await validateStageAutomationConfig(input.companyId, config);
      const [updated] = await db
        .update(pipelineStages)
        .set({
          ...input.patch,
          kind,
          config,
          updatedAt: nowDate(),
        })
        .where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.pipelineId, input.pipelineId)))
        .returning();
      if (!updated) throw notFound("Pipeline stage not found");
      return updated;
    },

    async deleteStage(input: {
      companyId: string;
      pipelineId: string;
      stageId: string;
      moveCasesToStageId?: string | null;
      actor?: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        await getPipelineOrThrow(tx, input.companyId, input.pipelineId);
        const stage = await getStageOrThrow(tx, input.pipelineId, input.stageId);
        const targetStage = input.moveCasesToStageId
          ? await getStageOrThrow(tx, input.pipelineId, input.moveCasesToStageId)
          : null;
        const casesInStage = await tx
          .select()
          .from(pipelineCases)
          .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.stageId, stage.id)));
        if (casesInStage.length > 0 && !targetStage) {
          throw unprocessable("Cannot delete a stage that holds cases without moveCasesToStageId", { code: "stage_has_cases" });
        }
        if (targetStage) {
          const movedCases = await tx
            .update(pipelineCases)
            .set({
              stageId: targetStage.id,
              version: sql`${pipelineCases.version} + 1`,
              terminalKind: terminalKindForStage(targetStage.kind),
              terminalAt: isTerminalKind(targetStage.kind) ? nowDate() : null,
              updatedAt: nowDate(),
            })
            .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.stageId, stage.id)))
            .returning();
          for (const movedCase of movedCases) {
            const previous = casesInStage.find((row) => row.id === movedCase.id);
            await writeCaseEvent(tx, {
              companyId: input.companyId,
              caseId: movedCase.id,
              type: "transitioned",
              actor: input.actor ?? { type: "system" },
              fromStageId: stage.id,
              toStageId: targetStage.id,
              payload: {
                reason: "stage_deleted",
                previousVersion: previous?.version ?? movedCase.version - 1,
                version: movedCase.version,
              },
            });
          }
        }
        await tx.delete(pipelineTransitions).where(or(eq(pipelineTransitions.fromStageId, stage.id), eq(pipelineTransitions.toStageId, stage.id)));
        await tx.delete(pipelineStages).where(eq(pipelineStages.id, stage.id));
        return { deleted: true };
      });
    },

    async createTransition(input: { companyId: string; pipelineId: string; fromStageId: string; toStageId: string; label?: string | null }) {
      await getPipelineOrThrow(db, input.companyId, input.pipelineId);
      await getStageOrThrow(db, input.pipelineId, input.fromStageId);
      await getStageOrThrow(db, input.pipelineId, input.toStageId);
      const [transition] = await db
        .insert(pipelineTransitions)
        .values({
          pipelineId: input.pipelineId,
          fromStageId: input.fromStageId,
          toStageId: input.toStageId,
          label: input.label ?? null,
        })
        .returning();
      return transition!;
    },

    async ingestCase(input: {
      companyId: string;
      pipelineId: string;
      caseKey?: string | null;
      title: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      stageKey?: string | null;
      parentCaseId?: string | null;
      blockedByCaseIds?: string[];
      blockedByCaseKeys?: string[];
      actor: PipelineActor;
    }) {
      assertJsonSize(input.fields ?? {}, "fields");
      assertActorProvenance(input.actor);
      const caseKey = input.caseKey ?? randomUUID();
      assertCaseKey(caseKey);

      return db.transaction(async (tx) => {
        const pipeline = await getPipelineOrThrow(tx, input.companyId, input.pipelineId);
        if (pipeline.archivedAt) throw unprocessable("Pipeline is archived", { code: "pipeline_archived" });
        await assertValidParentCase(tx, { companyId: input.companyId, parentCaseId: input.parentCaseId ?? null });
        const blockedByCaseKeyMap = await resolveBlockerCaseKeys(tx, {
          companyId: input.companyId,
          pipelineId: input.pipelineId,
          blockedByCaseKeys: input.blockedByCaseKeys ?? [],
        });
        const blockedByCaseIds = await validateBlockerSet(tx, {
          companyId: input.companyId,
          caseId: "__new_case__",
          blockedByCaseIds: [
            ...(input.blockedByCaseIds ?? []),
            ...Array.from(blockedByCaseKeyMap.values()),
          ],
        });
        const stage = input.stageKey
          ? await getStageByKeyOrThrow(tx, input.pipelineId, input.stageKey)
          : await tx
            .select()
            .from(pipelineStages)
            .where(eq(pipelineStages.pipelineId, input.pipelineId))
            .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
        if (!stage) throw unprocessable("Pipeline has no stages", { code: "validation" });

        const [inserted] = await tx
          .insert(pipelineCases)
          .values({
            companyId: input.companyId,
            pipelineId: input.pipelineId,
            stageId: stage.id,
            caseKey,
            title: input.title,
            summary: input.summary ?? null,
            fields: input.fields ?? {},
            parentCaseId: input.parentCaseId ?? null,
            terminalKind: terminalKindForStage(stage.kind),
            terminalAt: isTerminalKind(stage.kind) ? nowDate() : null,
            createdByUserId: input.actor.type === "user" ? input.actor.userId : null,
            createdByAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
            originRunId: input.actor.type === "agent" ? input.actor.runId : null,
          })
          .onConflictDoNothing({ target: [pipelineCases.pipelineId, pipelineCases.caseKey] })
          .returning();

        if (!inserted) {
          const existing = await tx
            .select()
            .from(pipelineCases)
            .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.caseKey, caseKey)))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!existing) throw conflict("Pipeline case ingest conflict", { code: "ingest_conflict" });
          return { case: existing, created: false };
        }

        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: inserted.id,
          type: "ingested",
          actor: input.actor,
          toStageId: stage.id,
          payload: { caseKey },
        });
        await adjustParentCounts(tx, {
          parentCaseId: inserted.parentCaseId,
          childDelta: 1,
          terminalChildDelta: isTerminalKind(inserted.terminalKind) ? 1 : 0,
        });
        if (blockedByCaseIds.length > 0) {
          await tx.insert(pipelineCaseBlockers).values(blockedByCaseIds.map((blockedByCaseId) => ({
            companyId: input.companyId,
            caseId: inserted.id,
            blockedByCaseId,
          })));
          await writeCaseEvent(tx, {
            companyId: input.companyId,
            caseId: inserted.id,
            type: "blockers_set",
            actor: input.actor,
            payload: {
              blockedByCaseIds,
              ...(input.blockedByCaseKeys?.length ? { blockedByCaseKeys: input.blockedByCaseKeys } : {}),
            },
          });
        }
        return { case: inserted, created: true };
      });
    },

    async ingestCases(input: {
      companyId: string;
      pipelineId: string;
      items: Array<{
        caseKey?: string | null;
        title: string;
        summary?: string | null;
        fields?: Record<string, unknown>;
        stageKey?: string | null;
        parentCaseId?: string | null;
        blockedByCaseIds?: string[];
        blockedByCaseKeys?: string[];
      }>;
      actor: PipelineActor;
    }) {
      if (input.items.length > MAX_BATCH_INGEST) {
        throw unprocessable("Batch ingest supports at most 200 items", { code: "validation" });
      }
      type BatchIngestResult =
        | Awaited<ReturnType<typeof service.ingestCase>> & { ok: true }
        | { ok: false; caseKey: string | null; error: Record<string, unknown> };
      const seen = new Set<string>();
      const results = new Array<BatchIngestResult | undefined>(input.items.length);
      const pending = new Set<number>();
      const firstBatchKeyIndexes = new Map<string, number>();
      for (const [index, item] of input.items.entries()) {
        const key = item.caseKey ?? null;
        if (key) {
          try {
            assertCaseKey(key);
          } catch (error) {
            results[index] = { ok: false as const, caseKey: key, error: pipelineBatchError(error, "validation") };
            continue;
          }
          if (seen.has(key)) {
            results[index] = { ok: false as const, caseKey: key, error: { code: "duplicate_batch_key" } };
            continue;
          }
          seen.add(key);
          firstBatchKeyIndexes.set(key, index);
        }
        pending.add(index);
      }

      const referencedKeys = [...new Set(input.items.flatMap((item) => item.blockedByCaseKeys ?? []))];
      const resolvedCaseIdsByKey = new Map<string, string>();
      for (const key of referencedKeys) {
        try {
          assertCaseKey(key);
        } catch {
          // Leave invalid keys unresolved so only rows that reference them fail below.
        }
      }
      const validReferencedKeys = referencedKeys.filter((key) => {
        try {
          assertCaseKey(key);
          return true;
        } catch {
          return false;
        }
      });
      if (validReferencedKeys.length > 0) {
        const rows = await db
          .select({ id: pipelineCases.id, caseKey: pipelineCases.caseKey })
          .from(pipelineCases)
          .where(and(
            eq(pipelineCases.companyId, input.companyId),
            eq(pipelineCases.pipelineId, input.pipelineId),
            inArray(pipelineCases.caseKey, validReferencedKeys),
          ));
        for (const row of rows) resolvedCaseIdsByKey.set(row.caseKey, row.id);
      }

      while (pending.size > 0) {
        let progressed = false;
        for (const index of [...pending]) {
          const item = input.items[index]!;
          const missingKeys = (item.blockedByCaseKeys ?? []).filter((key) => !resolvedCaseIdsByKey.has(key));
          if (missingKeys.length > 0) continue;

          pending.delete(index);
          progressed = true;
          const key = item.caseKey ?? null;
          try {
            const result = await service.ingestCase({
              ...item,
              companyId: input.companyId,
              pipelineId: input.pipelineId,
              actor: input.actor,
            });
            if (key) resolvedCaseIdsByKey.set(key, result.case.id);
            results[index] = { ok: true as const, ...result };
          } catch (error) {
            results[index] = { ok: false as const, caseKey: key, error: pipelineBatchError(error) };
          }
        }
        if (progressed) continue;

        const stuck = new Set(pending);
        for (const index of [...stuck]) {
          const item = input.items[index]!;
          const key = item.caseKey ?? null;
          const missingKeys = (item.blockedByCaseKeys ?? []).filter((blockedByCaseKey) => !resolvedCaseIdsByKey.has(blockedByCaseKey));
          const cyclicKeys = missingKeys.filter((blockedByCaseKey) => {
            const blockerIndex = firstBatchKeyIndexes.get(blockedByCaseKey);
            return blockerIndex !== undefined && stuck.has(blockerIndex);
          });
          results[index] = {
            ok: false as const,
            caseKey: key,
            error: cyclicKeys.length === missingKeys.length
              ? {
                status: 409,
                message: "Pipeline blocker cycle detected",
                details: { code: "blocker_cycle", blockedByCaseKeys: missingKeys },
              }
              : {
                status: 404,
                message: "Pipeline blocker case key not found",
                details: {
                  code: "blocker_case_key_not_found",
                  missingCaseKeys: missingKeys.filter((blockedByCaseKey) => !cyclicKeys.includes(blockedByCaseKey)),
                },
              },
          };
          pending.delete(index);
        }
      }

      return results.map((result, index) => result ?? {
        ok: false as const,
        caseKey: input.items[index]?.caseKey ?? null,
        error: { status: 500, message: "Unknown error", details: { code: "unknown" } },
      });
    },

    async patchCaseContent(input: {
      companyId: string;
      caseId: string;
      title?: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      parentCaseId?: string | null;
      expectedVersion?: number;
      leaseToken?: string | null;
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        const result = await patchCaseContentInTransaction(tx, input);
        return result.case;
      });
    },

    async claimCase(input: {
      companyId: string;
      caseId: string;
      actor: Extract<PipelineActor, { type: "user" | "agent" }>;
      leaseMs?: number;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const current = await expireLeaseIfNeeded(tx, existing, { type: "system" });
        if (hasValidLease(current) && !actorOwnsLease(current, input.actor, null)) {
          throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
        }
        const leaseMs = Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 1_000), MAX_LEASE_MS);
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + leaseMs);
        const [updated] = await tx
          .update(pipelineCases)
          .set({
            leaseOwnerType: input.actor.type,
            leaseAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
            leaseUserId: input.actor.type === "user" ? input.actor.userId : null,
            leaseToken: token,
            leaseExpiresAt: expiresAt,
            updatedAt: nowDate(),
          })
          .where(eq(pipelineCases.id, current.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: current.id,
          type: "claimed",
          actor: input.actor,
          payload: { leaseToken: token, leaseExpiresAt: expiresAt.toISOString() },
        });
        return updated!;
      });
    },

    async releaseCase(input: {
      companyId: string;
      caseId: string;
      actor: PipelineActor;
      leaseToken?: string | null;
      force?: boolean;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const current = await expireLeaseIfNeeded(tx, existing, { type: "system" });
        if (!input.force && hasValidLease(current) && !actorOwnsLease(current, input.actor, input.leaseToken)) {
          throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
        }
        const [updated] = await tx
          .update(pipelineCases)
          .set({
            leaseOwnerType: null,
            leaseAgentId: null,
            leaseUserId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: nowDate(),
          })
          .where(eq(pipelineCases.id, current.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: current.id,
          type: "lease_released",
          actor: input.actor,
          payload: { forced: input.force === true },
        });
        return updated!;
      });
    },

    async transitionCase(input: {
      companyId: string;
      caseId: string;
      toStageId?: string;
      toStageKey?: string;
      expectedVersion: number;
      leaseToken?: string | null;
      actor: PipelineActor;
      transitionClass?: "manual" | "suggested" | "auto";
      suggestionId?: string;
      reason?: string | null;
    }) {
      const result = await db.transaction((tx) => transitionCaseInTransaction(tx, input));
      if (result.automationLedger) {
        return {
          ...result,
          automationExecution: await executeAutomationLedger(result.automationLedger.id, { type: "system" }),
        };
      }
      return { ...result, automationExecution: { status: "none" } satisfies PipelineAutomationExecutionResult };
    },

    async retryAutomation(input: {
      companyId: string;
      caseId: string;
      automationId: string;
      actor: PipelineActor;
    }) {
      const execution = await db
        .select()
        .from(pipelineAutomationExecutions)
        .where(and(
          eq(pipelineAutomationExecutions.companyId, input.companyId),
          eq(pipelineAutomationExecutions.caseId, input.caseId),
          eq(pipelineAutomationExecutions.automationId, input.automationId),
        ))
        .orderBy(sql`case when ${pipelineAutomationExecutions.status} = 'failed' then 0 else 1 end`, asc(pipelineAutomationExecutions.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!execution) throw notFound("Pipeline automation execution not found");
      return executeAutomationLedger(execution.id, input.actor);
    },

    async validateStageAutomationConfig(companyId: string, config?: PipelineStageConfig | null) {
      return validateStageAutomationConfig(companyId, config);
    },

    async suggestTransition(input: {
      companyId: string;
      caseId: string;
      toStageKey: string;
      rationale: string;
      confidence?: number;
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        await getStageByKeyOrThrow(tx, existing.pipelineId, input.toStageKey);
        const suggestion = {
          id: randomUUID(),
          toStageKey: input.toStageKey,
          rationale: input.rationale,
          confidence: input.confidence,
          suggestedByAgentId: input.actor.type === "agent" ? input.actor.agentId : undefined,
          runId: input.actor.type === "agent" ? input.actor.runId : undefined,
          createdAt: nowDate().toISOString(),
        };
        const superseded = existing.pendingSuggestion ?? null;
        const [updated] = await tx
          .update(pipelineCases)
          .set({ pendingSuggestion: suggestion, updatedAt: nowDate() })
          .where(eq(pipelineCases.id, existing.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: existing.id,
          type: "transition_suggested",
          actor: input.actor,
          payload: { suggestion, supersededSuggestionId: superseded?.id ?? null },
        });
        return { case: updated!, suggestion };
      });
    },

    async resolveSuggestion(input: {
      companyId: string;
      caseId: string;
      suggestionId: string;
      decision: "accept" | "dismiss";
      expectedVersion?: number;
      actor: PipelineActor;
      reason?: string | null;
      leaseToken?: string | null;
    }) {
      const result = await db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const suggestion = existing.pendingSuggestion;
        if (!suggestion || suggestion.id !== input.suggestionId) {
          throw conflict("Pipeline suggestion is not pending", { code: "suggestion_not_pending" });
        }
        if (input.decision === "dismiss") {
          const [updated] = await tx
            .update(pipelineCases)
            .set({ pendingSuggestion: null, updatedAt: nowDate() })
            .where(eq(pipelineCases.id, existing.id))
            .returning();
          const event = await writeCaseEvent(tx, {
            companyId: input.companyId,
            caseId: existing.id,
            type: "suggestion_resolved",
            actor: input.actor,
            payload: { suggestionId: input.suggestionId, decision: "dismiss", reason: input.reason ?? null },
          });
          return { case: updated!, event };
        }

        const transition = await transitionCaseInTransaction(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          toStageKey: suggestion.toStageKey,
          expectedVersion: input.expectedVersion ?? existing.version,
          actor: input.actor,
          leaseToken: input.leaseToken,
          transitionClass: "suggested",
          suggestionId: input.suggestionId,
          reason: input.reason,
        });
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: existing.id,
          type: "suggestion_resolved",
          actor: input.actor,
          payload: { suggestionId: input.suggestionId, decision: "accept", reason: input.reason ?? null },
        });
        return transition;
      });
      if ("automationLedger" in result && result.automationLedger) {
        return {
          ...result,
          automationExecution: await executeAutomationLedger(result.automationLedger.id, { type: "system" }),
        };
      }
      return result;
    },

    async reviewCase(input: {
      companyId: string;
      caseId: string;
      decision: PipelineReviewDecision;
      reason?: string | null;
      edits?: {
        title?: string;
        summary?: string | null;
        fields?: Record<string, unknown>;
        parentCaseId?: string | null;
      };
      expectedVersion: number;
      leaseToken?: string | null;
      actor: PipelineActor;
    }) {
      const result = await db.transaction(async (tx) => {
        const detail = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        if (detail.stage.kind !== "review") {
          throw unprocessable("Pipeline case is not in a review stage", { code: "validation" });
        }
        const config = reviewConfigForStage(detail.stage);
        if (input.actor.type === "agent" && config.reviewerKind !== "any") {
          throw new HttpError(403, "Human review is required", { code: "review_required" });
        }
        if (input.decision !== "approve" && config.requireRejectReason !== false && !input.reason?.trim()) {
          throw unprocessable("Review decision reason is required", { code: "validation" });
        }
        const toStageKey = targetStageKeyForReviewDecision(config, input.decision);
        const suggestionId = detail.case.pendingSuggestion?.id ?? null;
        let expectedVersion = input.expectedVersion;
        let updateEvent: typeof pipelineCaseEvents.$inferSelect | null = null;
        const hasEdits = input.edits && Object.keys(input.edits).length > 0;

        if (hasEdits) {
          const updated = await patchCaseContentInTransaction(tx, {
            companyId: input.companyId,
            caseId: input.caseId,
            ...input.edits,
            expectedVersion,
            leaseToken: input.leaseToken,
            actor: input.actor,
          });
          expectedVersion = updated.case.version;
          updateEvent = updated.event;
        }

        const transitioned = await transitionCaseInTransaction(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          toStageKey,
          expectedVersion,
          leaseToken: input.leaseToken,
          reason: input.reason,
          actor: input.actor,
        });
        const reviewEvent = await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          type: "review_decided",
          actor: input.actor,
          fromStageId: detail.stage.id,
          toStageId: transitioned.case.stageId,
          payload: {
            decision: input.decision,
            reason: input.reason ?? null,
            suggestionId,
            updateEventId: updateEvent?.id ?? null,
            transitionEventId: transitioned.event.id,
          },
        });
        return { ...transitioned, updateEvent, reviewEvent };
      });
      if (result.automationLedger) {
        return {
          ...result,
          automationExecution: await executeAutomationLedger(result.automationLedger.id, { type: "system" }),
        };
      }
      return { ...result, automationExecution: { status: "none" } satisfies PipelineAutomationExecutionResult };
    },

    async listReviewCases(input: {
      companyId: string;
      pipelineId?: string;
      parentCaseId?: string;
    }) {
      const parentCase = alias(pipelineCases, "parent_pipeline_case");
      const rows = await db
        .select({ case: pipelineCases, pipeline: pipelines, stage: pipelineStages, parentCase })
        .from(pipelineCases)
        .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
        .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
        .leftJoin(parentCase, and(eq(pipelineCases.parentCaseId, parentCase.id), eq(parentCase.companyId, input.companyId)))
        .where(and(
          eq(pipelineCases.companyId, input.companyId),
          eq(pipelines.companyId, input.companyId),
          eq(pipelineStages.kind, "review"),
          isNull(pipelineCases.terminalKind),
          input.pipelineId ? eq(pipelineCases.pipelineId, input.pipelineId) : undefined,
          input.parentCaseId ? eq(pipelineCases.parentCaseId, input.parentCaseId) : undefined,
        ))
        .orderBy(asc(pipelineCases.createdAt));
      return rows.map((row) => ({
        ...row,
        pendingSuggestion: row.case.pendingSuggestion,
        reviewConfig: reviewConfigForStage(row.stage),
      }));
    },

    async replaceBlockers(input: {
      companyId: string;
      caseId: string;
      blockedByCaseIds: string[];
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const blockedByCaseIds = await validateBlockerSet(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          blockedByCaseIds: input.blockedByCaseIds,
        });
        await tx.delete(pipelineCaseBlockers).where(and(
          eq(pipelineCaseBlockers.companyId, input.companyId),
          eq(pipelineCaseBlockers.caseId, input.caseId),
        ));
        if (blockedByCaseIds.length > 0) {
          await tx.insert(pipelineCaseBlockers).values(blockedByCaseIds.map((blockedByCaseId) => ({
            companyId: input.companyId,
            caseId: input.caseId,
            blockedByCaseId,
          })));
        }
        const event = await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          type: "blockers_set",
          actor: input.actor,
          payload: { blockedByCaseIds },
        });
        const blockers = await tx
          .select()
          .from(pipelineCaseBlockers)
          .where(and(eq(pipelineCaseBlockers.companyId, input.companyId), eq(pipelineCaseBlockers.caseId, input.caseId)));
        return { blockers, event };
      });
    },

    async getCaseRollup(companyId: string, caseId: string) {
      return computeCaseRollup(db, companyId, caseId);
    },

    async listCaseEventsPage(
      companyId: string,
      caseId: string,
      options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
    ) {
      const limit = Math.min(
        PIPELINE_CASE_EVENTS_MAX_LIMIT,
        Math.max(1, Math.floor(options?.limit ?? PIPELINE_CASE_EVENTS_DEFAULT_LIMIT)),
      );
      const offset = Math.max(0, Math.floor(options?.offset ?? 0));
      const order = options?.order ?? "asc";
      await getCaseWithStageOrThrow(db, companyId, caseId);
      const rows = await db
        .select()
        .from(pipelineCaseEvents)
        .where(and(eq(pipelineCaseEvents.companyId, companyId), eq(pipelineCaseEvents.caseId, caseId)))
        .orderBy(order === "desc" ? desc(pipelineCaseEvents.createdAt) : asc(pipelineCaseEvents.createdAt))
        .limit(limit + 1)
        .offset(offset);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return {
        items,
        pagination: {
          limit,
          offset,
          nextOffset: hasMore ? offset + limit : null,
          hasMore,
          order,
        },
      };
    },

    async listCaseEvents(companyId: string, caseId: string) {
      await getCaseWithStageOrThrow(db, companyId, caseId);
      return db
        .select()
        .from(pipelineCaseEvents)
        .where(and(eq(pipelineCaseEvents.companyId, companyId), eq(pipelineCaseEvents.caseId, caseId)))
        .orderBy(asc(pipelineCaseEvents.createdAt));
    },
  };

  return service;
}
