import { Router, type Request } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documents,
  documentRevisions,
  issues as issueRows,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  routines,
} from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import {
  PIPELINE_CASE_EVENTS_DEFAULT_LIMIT,
  PIPELINE_CASE_EVENTS_MAX_LIMIT,
  PIPELINE_CONTEXT_PACK_EVENT_LIMIT,
  pipelineService,
  type PipelineActor,
  type PipelineStageConfig,
  type PipelineStageKind,
} from "../services/pipelines.js";
import {
  COMPANY_CASE_EVENTS_DEFAULT_LIMIT,
  COMPANY_CASE_EVENTS_MAX_LIMIT,
  COMPANY_CASE_EVENTS_MAX_TYPES,
  getCaseChildrenTree,
  getDirectChildrenSummary,
  listCompanyCaseEvents,
  listPipelineAttention,
  loadActiveWorkForCases,
  loadPipelineConnections,
  PIPELINE_ATTENTION_DEFAULT_LIMIT,
  PIPELINE_ATTENTION_MAX_LIMIT,
  type AttentionCaller,
} from "../services/pipelines-aggregation.js";
import { accessService } from "../services/access.js";
import { issueService } from "../services/issues.js";
import { assertCompanyAccess } from "./authz.js";
import {
  computePipelineHealth,
  deriveCaseType,
  type PipelineHealthFailedAutomationInput,
  type PipelineHealthStageInput,
} from "@paperclipai/shared";

/** Per-stage instructions document keys look like `stage-instructions:{stageId}`. */
const STAGE_INSTRUCTIONS_PREFIX = "stage-instructions:";

const stageKindSchema = z.enum(["open", "working", "review", "done", "cancelled"]);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const stageConfigSchema = z.record(z.string(), z.unknown()).default({});
const casePatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  workspaceRef: jsonObjectSchema.nullable().optional(),
  parentCaseId: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().positive().optional(),
  leaseToken: z.string().uuid().nullable().optional(),
});
const ingestCaseSchema = z.object({
  caseKey: z.string().max(1_024).nullable().optional(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  stageKey: z.string().trim().min(1).max(120).optional(),
  parentCaseId: z.string().uuid().nullable().optional(),
  requestKey: z.string().trim().min(1).max(512).optional(),
  workspaceRef: jsonObjectSchema.nullable().optional(),
  blockedByCaseIds: z.array(z.string().uuid()).max(100).optional(),
  blockedByCaseKeys: z.array(z.string().max(1_024)).max(100).optional(),
});
const createPipelineSchema = z.object({
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(8_000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  enforceTransitions: z.boolean().optional(),
  stages: z.array(z.object({
    key: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200),
    kind: stageKindSchema,
    position: z.number().int().optional(),
    config: stageConfigSchema.optional(),
  })).optional(),
});
const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8_000).nullable().optional(),
  enforceTransitions: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const createStageSchema = z.object({
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  kind: stageKindSchema,
  position: z.number().int(),
  config: stageConfigSchema.optional(),
});
const updateStageSchema = z.object({
  key: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  kind: stageKindSchema.optional(),
  position: z.number().int().optional(),
  config: stageConfigSchema.optional(),
});
const replaceTransitionsSchema = z.object({
  transitions: z.array(z.object({
    fromStageKey: z.string().trim().min(1).max(120),
    toStageKey: z.string().trim().min(1).max(120),
    label: z.string().max(200).nullable().optional(),
  })).max(500),
  enforceTransitions: z.boolean().optional(),
});
const batchIngestSchema = z.object({ items: z.array(ingestCaseSchema).max(200) });
const claimCaseSchema = z.object({ leaseSeconds: z.number().int().positive().max(86_400).optional() });
const releaseCaseSchema = z.object({
  leaseToken: z.string().uuid().nullable().optional(),
  force: z.boolean().optional(),
});
const transitionCaseSchema = z.object({
  toStageKey: z.string().trim().min(1).max(120),
  expectedVersion: z.number().int().positive(),
  leaseToken: z.string().uuid().nullable().optional(),
  reason: z.string().max(4_000).nullable().optional(),
  force: z.boolean().optional(),
  acceptSuggestionId: z.string().uuid().optional(),
});
const suggestTransitionSchema = z.object({
  toStageKey: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(8_000),
  confidence: z.number().min(0).max(1).optional(),
});
const resolveSuggestionSchema = z.object({
  suggestionId: z.string().uuid(),
  resolution: z.enum(["accept", "dismiss"]),
  expectedVersion: z.number().int().positive().optional(),
  reason: z.string().max(4_000).nullable().optional(),
  leaseToken: z.string().uuid().nullable().optional(),
});
const acknowledgeDriftSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});
const reviewEditsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().max(8_000).nullable().optional(),
  fields: jsonObjectSchema.optional(),
  parentCaseId: z.string().uuid().nullable().optional(),
});
const reviewCaseSchema = z.object({
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().max(4_000).nullable().optional(),
  edits: reviewEditsSchema.optional(),
  expectedVersion: z.number().int().positive(),
  leaseToken: z.string().uuid().nullable().optional(),
});
const blockersSchema = z.object({ blockedByCaseIds: z.array(z.string().uuid()).max(100) });
const issueLinkRoleSchema = z.enum(["origin", "conversation", "work", "automation"]);
const createIssueLinkSchema = z.object({
  issueId: z.string().uuid(),
  role: issueLinkRoleSchema,
});
const bulkReviewSchema = z.object({
  items: z.array(reviewCaseSchema.extend({ caseId: z.string().uuid() })).max(100),
});
const upsertPipelineDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200_000),
  baseRevisionId: z.string().uuid().nullable().optional(),
});
const intakeFieldTypes = new Set(["select", "text", "multiline"]);

function stageAutomationRoutineId(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const onEnter = (config as { onEnter?: unknown }).onEnter;
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) return null;
  const record = onEnter as Record<string, unknown>;
  return record.type === "run_routine" && typeof record.routineId === "string" ? record.routineId : null;
}

function withDerivedStageAutomation(
  stage: typeof pipelineStages.$inferSelect,
  routineById: Map<string, { assigneeAgentId: string | null; description: string | null }>,
) {
  const config = stage.config && typeof stage.config === "object" && !Array.isArray(stage.config)
    ? { ...(stage.config as Record<string, unknown>) }
    : {};
  const routineId = stageAutomationRoutineId(config);
  const routine = routineId ? routineById.get(routineId) : null;
  if (!routine) return { ...stage, config };
  return {
    ...stage,
    config: {
      ...config,
      automation: {
        assigneeAgentId: routine.assigneeAgentId,
        instructionsBody: routine.description ?? "",
      },
    },
  };
}

function extractIntakeFormFields(stage: typeof pipelineStages.$inferSelect | null) {
  const baseFields = [{ key: "title", label: "Name", type: "text", required: true, options: [] as string[] }];
  const variables = stage?.config && typeof stage.config === "object" && !Array.isArray(stage.config)
    ? (stage.config as { variables?: unknown }).variables
    : null;
  if (!Array.isArray(variables)) return baseFields;

  return [
    ...baseFields,
    ...variables.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const variable = raw as Record<string, unknown>;
      const routineName = typeof variable.name === "string" && variable.name.trim().length > 0
        ? variable.name.trim()
        : null;
      const legacyKey = typeof variable.key === "string" && variable.key.trim().length > 0
        ? variable.key.trim()
        : null;

      const options = Array.isArray(variable.options)
        ? variable.options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
        : [];

      // Routine variable shape (body-driven `{{name}}`): every variable on the
      // stage becomes an Add-item field; routine types map onto intake types.
      if (routineName) {
        const rawType = typeof variable.type === "string" ? variable.type : "text";
        const type = rawType === "select"
          ? "select"
          : rawType === "textarea" || rawType === "multiline"
            ? "multiline"
            : "text";
        const label = typeof variable.label === "string" && variable.label.trim().length > 0
          ? variable.label.trim()
          : routineName;
        return [{ key: routineName, label, type, required: variable.required === true, options }];
      }

      // Legacy pipeline variable shape: opt-in via `showInAddForm`, keyed by `key`.
      if (!legacyKey) return [];
      if (variable.showInAddForm !== true) return [];
      if (typeof variable.label !== "string" || variable.label.trim().length === 0) return [];
      const type = typeof variable.type === "string" && intakeFieldTypes.has(variable.type) ? variable.type : "text";
      return [{
        key: legacyKey,
        label: variable.label,
        type,
        required: variable.required === true,
        options,
      }];
    }),
  ];
}

function isPgUniqueViolation(error: unknown) {
  return (error as { code?: unknown })?.code === "23505";
}

function codedConflictForUnique(error: unknown): never {
  if (isPgUniqueViolation(error)) {
    throw conflict("Duplicate pipeline resource key", { code: "duplicate_key" });
  }
  throw error;
}

function assertPipelineCompanyAccess(req: Request, companyId: string) {
  try {
    assertCompanyAccess(req, companyId);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 403 &&
      (error.message.includes("another company") || error.message.includes("does not have access"))
    ) {
      throw notFound("Pipeline resource not found");
    }
    throw error;
  }
}

function actorForMutation(req: Request): PipelineActor {
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw unauthorized();
    if (!req.actor.runId) throw unprocessable("Agent pipeline mutations require a run id", { code: "run_id_required" });
    return { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId };
  }
  if (req.actor.type === "board") {
    return { type: "user", userId: req.actor.userId ?? "board" };
  }
  throw unauthorized();
}

function attentionCallerFor(req: Request): AttentionCaller {
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw unauthorized();
    return { type: "agent", agentId: req.actor.agentId };
  }
  if (req.actor.type === "board") {
    return { type: "user", userId: req.actor.userId ?? "board" };
  }
  throw unauthorized();
}

function parseEventTypesQuery(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const types = raw
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (types.length === 0) return undefined;
  if (types.length > COMPANY_CASE_EVENTS_MAX_TYPES) {
    throw badRequest(`types accepts at most ${COMPANY_CASE_EVENTS_MAX_TYPES} values`);
  }
  for (const type of types) {
    if (!/^[a-z_]{1,64}$/.test(type)) throw badRequest(`Invalid event type: ${type}`);
  }
  return [...new Set(types)];
}

function parseOptionalNonNegativeInteger(value: unknown, name: string) {
  if (value === undefined) return null;
  if (Array.isArray(value)) throw badRequest(`${name} must be a single integer`);
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} is too large`);
  return parsed;
}

function parseCaseEventsQuery(query: Request["query"]) {
  const requestedLimit = parseOptionalNonNegativeInteger(query.limit, "limit");
  const offset = parseOptionalNonNegativeInteger(query.offset, "offset") ?? 0;
  if (requestedLimit === 0) throw badRequest("limit must be a positive integer");
  return {
    limit: Math.min(requestedLimit ?? PIPELINE_CASE_EVENTS_DEFAULT_LIMIT, PIPELINE_CASE_EVENTS_MAX_LIMIT),
    offset,
  };
}

async function resolvePipelineCompanyId(db: Db, pipelineId: string) {
  const row = await db
    .select({ companyId: pipelines.companyId })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline not found");
  return row.companyId;
}

async function resolveCaseCompanyId(db: Db, caseId: string) {
  const row = await db
    .select({ companyId: pipelineCases.companyId })
    .from(pipelineCases)
    .where(eq(pipelineCases.id, caseId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  return row.companyId;
}

async function assertPipelineAccess(db: Db, req: Request, pipelineId: string) {
  const companyId = await resolvePipelineCompanyId(db, pipelineId);
  assertPipelineCompanyAccess(req, companyId);
  return companyId;
}

function mapPipelineDocumentRevision(row: {
  id: string;
  companyId: string;
  documentId: string;
  pipelineId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}) {
  return row;
}

async function getPipelineDocumentRow(db: Db, input: { companyId: string; pipelineId: string; key: string }) {
  return db
    .select({ link: pipelineDocuments, document: documents, revision: documentRevisions })
    .from(pipelineDocuments)
    .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
    .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
    .where(and(
      eq(pipelineDocuments.companyId, input.companyId),
      eq(pipelineDocuments.pipelineId, input.pipelineId),
      eq(pipelineDocuments.key, input.key),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function listPipelineDocumentRevisions(db: Db, input: { companyId: string; pipelineId: string; key: string }) {
  return db
    .select({
      id: documentRevisions.id,
      companyId: documentRevisions.companyId,
      documentId: documentRevisions.documentId,
      pipelineId: pipelineDocuments.pipelineId,
      key: pipelineDocuments.key,
      revisionNumber: documentRevisions.revisionNumber,
      title: documentRevisions.title,
      format: documentRevisions.format,
      body: documentRevisions.body,
      changeSummary: documentRevisions.changeSummary,
      createdByAgentId: documentRevisions.createdByAgentId,
      createdByUserId: documentRevisions.createdByUserId,
      createdAt: documentRevisions.createdAt,
    })
    .from(pipelineDocuments)
    .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
    .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
    .where(and(
      eq(pipelineDocuments.companyId, input.companyId),
      eq(pipelineDocuments.pipelineId, input.pipelineId),
      eq(pipelineDocuments.key, input.key),
    ))
    .orderBy(desc(documentRevisions.revisionNumber))
    .then((rows) => rows.map(mapPipelineDocumentRevision));
}

async function assertCaseAccess(db: Db, req: Request, caseId: string) {
  const companyId = await resolveCaseCompanyId(db, caseId);
  assertPipelineCompanyAccess(req, companyId);
  return companyId;
}

async function getStagesByKey(db: Db, pipelineId: string) {
  const rows = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId));
  return new Map(rows.map((stage) => [stage.key, stage]));
}

async function writeRouteEvent(
  db: Pick<Db, "insert">,
  input: {
    companyId: string;
    caseId: string;
    type: string;
    actor: PipelineActor;
    payload?: Record<string, unknown>;
  },
) {
  const actorPatch = input.actor.type === "agent"
    ? { actorType: "agent", actorAgentId: input.actor.agentId, runId: input.actor.runId }
    : input.actor.type === "user"
      ? { actorType: "user", actorUserId: input.actor.userId }
      : { actorType: "system" };
  const [event] = await db.insert(pipelineCaseEvents).values({
    companyId: input.companyId,
    caseId: input.caseId,
    type: input.type,
    ...actorPatch,
    payload: input.payload ?? {},
  }).returning();
  return event!;
}

async function getIssueMutationTarget(db: Db, input: { companyId: string; issueId: string }) {
  return db
    .select({
      id: issueRows.id,
      companyId: issueRows.companyId,
      projectId: issueRows.projectId,
      parentId: issueRows.parentId,
      assigneeAgentId: issueRows.assigneeAgentId,
      assigneeUserId: issueRows.assigneeUserId,
      status: issueRows.status,
    })
    .from(issueRows)
    .where(and(eq(issueRows.id, input.issueId), eq(issueRows.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function assertIssueLinkMutationAllowed(
  req: Request,
  input: {
    access: ReturnType<typeof accessService>;
    issuesSvc: ReturnType<typeof issueService>;
    issue: NonNullable<Awaited<ReturnType<typeof getIssueMutationTarget>>>;
  },
) {
  const decision = await input.access.decide({
    actor: req.actor,
    action: "issue:mutate",
    resource: {
      type: "issue",
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      projectId: input.issue.projectId,
      parentIssueId: input.issue.parentId,
      assigneeAgentId: input.issue.assigneeAgentId,
      assigneeUserId: input.issue.assigneeUserId,
      status: input.issue.status,
    },
    scope: {
      issueId: input.issue.id,
      projectId: input.issue.projectId,
      parentIssueId: input.issue.parentId,
      assigneeAgentId: input.issue.assigneeAgentId,
      assigneeUserId: input.issue.assigneeUserId,
    },
  });
  if (!decision.allowed) {
    throw forbidden("Issue is outside this actor's authorization boundary");
  }
  if (req.actor.type !== "agent") return;
  const actorAgentId = req.actor.agentId;
  if (!actorAgentId) throw forbidden("Agent authentication required");
  if (input.issue.assigneeAgentId === null) return;
  if (input.issue.assigneeAgentId !== actorAgentId) {
    if (input.issue.status === "in_progress") {
      throw conflict("Issue is checked out by another agent", {
        issueId: input.issue.id,
        assigneeAgentId: input.issue.assigneeAgentId,
        actorAgentId,
      });
    }
    throw forbidden("Agent cannot mutate another agent's issue");
  }
  if (input.issue.status !== "in_progress") return;
  const runId = req.actor.runId?.trim();
  if (!runId) throw unauthorized("Agent run id required");
  await input.issuesSvc.assertCheckoutOwner(input.issue.id, actorAgentId, runId);
}

export function pipelineRoutes(db: Db, options: Parameters<typeof pipelineService>[1] = {}) {
  const router = Router();
  const svc = pipelineService(db, options);
  const access = accessService(db);
  const issuesSvc = issueService(db);

  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const rows = await db
      .select({
        pipeline: pipelines,
        stageCount: sql<number>`count(distinct ${pipelineStages.id})::int`,
        openCaseCount: sql<number>`count(distinct ${pipelineCases.id}) filter (where ${pipelineCases.terminalKind} is null)::int`,
        attentionCount: sql<number>`count(distinct ${pipelineCases.id}) filter (where ${pipelineCases.terminalKind} is null and (${pipelineCases.pendingSuggestion} is not null or (${pipelineCases.stageId} = ${pipelineStages.id} and ${pipelineStages.kind} = 'review')))::int`,
        inMotionCount: sql<number>`count(distinct ${pipelineCases.id}) filter (where ${pipelineCases.terminalKind} is null and ${pipelineCases.stageId} = ${pipelineStages.id} and ${pipelineStages.kind} = 'working')::int`,
        lastActivityAt: sql<string | null>`max(${pipelineCases.updatedAt})`,
      })
      .from(pipelines)
      .leftJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
      .leftJoin(pipelineCases, eq(pipelineCases.pipelineId, pipelines.id))
      .where(eq(pipelines.companyId, companyId))
      .groupBy(pipelines.id)
      .orderBy(asc(pipelines.createdAt));
    const connections = await loadPipelineConnections(db, companyId);
    const pipelineIds = rows.map((row) => row.pipeline.id);
    const stageRows = pipelineIds.length > 0
      ? await db
        .select()
        .from(pipelineStages)
        .where(inArray(pipelineStages.pipelineId, pipelineIds))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
      : [];
    const stagesByPipelineId = new Map<string, typeof stageRows>();
    for (const stage of stageRows) {
      const stages = stagesByPipelineId.get(stage.pipelineId) ?? [];
      stages.push(stage);
      stagesByPipelineId.set(stage.pipelineId, stages);
    }
    res.json(rows.map((row) => ({
      ...row.pipeline,
      stageCount: row.stageCount,
      stages: stagesByPipelineId.get(row.pipeline.id) ?? [],
      openCaseCount: row.openCaseCount,
      attentionCount: row.attentionCount,
      inMotionCount: row.inMotionCount,
      lastActivityAt: row.lastActivityAt,
      connections: connections.get(row.pipeline.id) ?? { upstreamPipelineIds: [], downstreamPipelineIds: [] },
    })));
  });

  router.get("/companies/:companyId/pipelines-attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const caller = attentionCallerFor(req);
    const requestedLimit = parseOptionalNonNegativeInteger(req.query.limit, "limit");
    if (requestedLimit === 0) throw badRequest("limit must be a positive integer");
    const limit = Math.min(requestedLimit ?? PIPELINE_ATTENTION_DEFAULT_LIMIT, PIPELINE_ATTENTION_MAX_LIMIT);
    res.json(await listPipelineAttention(db, { companyId, caller, limit }));
  });

  router.get("/companies/:companyId/case-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const types = parseEventTypesQuery(req.query.types);
    const requestedLimit = parseOptionalNonNegativeInteger(req.query.limit, "limit");
    if (requestedLimit === 0) throw badRequest("limit must be a positive integer");
    const limit = Math.min(requestedLimit ?? COMPANY_CASE_EVENTS_DEFAULT_LIMIT, COMPANY_CASE_EVENTS_MAX_LIMIT);
    const offset = parseOptionalNonNegativeInteger(req.query.offset, "offset") ?? 0;
    res.json(await listCompanyCaseEvents(db, { companyId, types, limit, offset }));
  });

  router.post("/companies/:companyId/pipelines", validate(createPipelineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const actor = actorForMutation(req);
    try {
      const created = await svc.createPipeline({
        companyId,
        key: req.body.key,
        name: req.body.name,
        description: req.body.description,
        projectId: req.body.projectId,
        enforceTransitions: req.body.enforceTransitions,
        stages: req.body.stages?.map((stage: {
          key: string;
          name: string;
          kind: PipelineStageKind;
          position?: number;
          config?: Record<string, unknown>;
        }) => ({
          ...stage,
          kind: stage.kind as PipelineStageKind,
          config: stage.config as PipelineStageConfig | undefined,
        })),
        actor,
      });
      res.status(201).json(created);
    } catch (error) {
      codedConflictForUnique(error);
    }
  });

  router.get("/companies/:companyId/review-cases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const pipelineId = typeof req.query.pipelineId === "string" ? req.query.pipelineId : undefined;
    const parentCaseId = typeof req.query.parentCaseId === "string" ? req.query.parentCaseId : undefined;
    res.json(await svc.listReviewCases({ companyId, pipelineId, parentCaseId }));
  });

  router.post("/companies/:companyId/review-cases/bulk", validate(bulkReviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const actor = actorForMutation(req);
    const results = [];
    for (const item of req.body.items) {
      try {
        results.push({ caseId: item.caseId, ok: true, result: await svc.reviewCase({ companyId, ...item, actor }) });
      } catch (error) {
        const httpError = error as { status?: number; message?: string; details?: unknown };
        const details = httpError.details && typeof httpError.details === "object" && !Array.isArray(httpError.details)
          ? httpError.details as Record<string, unknown>
          : null;
        results.push({
          caseId: item.caseId,
          ok: false,
          error: {
            status: httpError.status ?? 500,
            message: httpError.message ?? "Unknown error",
            code: typeof details?.code === "string" ? details.code : undefined,
            details: httpError.details,
          },
        });
      }
    }
    res.json({ results });
  });

  router.get("/pipelines/:pipelineId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const [pipeline, stages, transitions, documentKeys] = await Promise.all([
      db.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId))).then((rows) => rows[0] ?? null),
      db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.position)),
      db.select().from(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, pipelineId)),
      db.select({ key: pipelineDocuments.key, documentId: pipelineDocuments.documentId })
        .from(pipelineDocuments)
        .where(and(eq(pipelineDocuments.companyId, companyId), eq(pipelineDocuments.pipelineId, pipelineId))),
    ]);
    if (!pipeline) throw notFound("Pipeline not found");
    const automationRoutineIds = stages.flatMap((stage) => {
      const routineId = stageAutomationRoutineId(stage.config);
      return routineId ? [routineId] : [];
    });
    const routineRows = automationRoutineIds.length > 0
      ? await db
          .select({ id: routines.id, assigneeAgentId: routines.assigneeAgentId, description: routines.description })
          .from(routines)
          .where(and(eq(routines.companyId, companyId), inArray(routines.id, automationRoutineIds)))
      : [];
    const routineById = new Map(routineRows.map((row) => [
      row.id,
      { assigneeAgentId: row.assigneeAgentId, description: row.description },
    ]));
    res.json({ ...pipeline, stages: stages.map((stage) => withDerivedStageAutomation(stage, routineById)), transitions, documentKeys });
  });

  // Setup-health warnings: surface any configuration that won't actually run
  // (paused teammate, missing instructions, no approver, broken hand-off links,
  // unset required details) in plain prosumer language. Assembles the cross-
  // entity inputs the pure `computePipelineHealth` needs.
  router.get("/pipelines/:pipelineId/health", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const [pipeline, stages, instructionDocs, companyAgents, companyPipelines, companyStages, failedAutomationRows] = await Promise.all([
      db.select().from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)))
        .then((rows) => rows[0] ?? null),
      db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.position)),
      db.select({ key: pipelineDocuments.key, body: documentRevisions.body })
        .from(pipelineDocuments)
        .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(
          eq(pipelineDocuments.companyId, companyId),
          eq(pipelineDocuments.pipelineId, pipelineId),
          ilike(pipelineDocuments.key, `${STAGE_INSTRUCTIONS_PREFIX}%`),
        )),
      db.select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
      db.select({ id: pipelines.id, name: pipelines.name })
        .from(pipelines)
        .where(eq(pipelines.companyId, companyId)),
      db.select({ pipelineId: pipelineStages.pipelineId, key: pipelineStages.key, name: pipelineStages.name })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
        .where(eq(pipelines.companyId, companyId)),
      db.select({
        caseId: pipelineCases.id,
        caseTitle: pipelineCases.title,
        stageId: pipelineStages.id,
        stageKey: pipelineStages.key,
        stageName: pipelineStages.name,
        error: pipelineAutomationExecutions.error,
      })
        .from(pipelineAutomationExecutions)
        .innerJoin(pipelineCases, eq(pipelineAutomationExecutions.caseId, pipelineCases.id))
        .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
        .where(and(
          eq(pipelineAutomationExecutions.companyId, companyId),
          eq(pipelineCases.pipelineId, pipelineId),
          eq(pipelineAutomationExecutions.status, "failed"),
          isNull(pipelineCases.terminalKind),
        ))
        .orderBy(desc(pipelineAutomationExecutions.updatedAt))
        .limit(50),
    ]);
    if (!pipeline) throw notFound("Pipeline not found");

    const automationRoutineIds = stages.flatMap((stage) => {
      const routineId = stageAutomationRoutineId(stage.config);
      return routineId ? [routineId] : [];
    });
    const routineRows = automationRoutineIds.length > 0
      ? await db
          .select({ id: routines.id, assigneeAgentId: routines.assigneeAgentId, description: routines.description })
          .from(routines)
          .where(and(eq(routines.companyId, companyId), inArray(routines.id, automationRoutineIds)))
      : [];
    const routineById = new Map(routineRows.map((row) => [
      row.id,
      { assigneeAgentId: row.assigneeAgentId, description: row.description },
    ]));

    const bodyByStageId = new Map<string, string>();
    for (const doc of instructionDocs) {
      if (!doc.key.startsWith(STAGE_INSTRUCTIONS_PREFIX)) continue;
      bodyByStageId.set(doc.key.slice(STAGE_INSTRUCTIONS_PREFIX.length), doc.body ?? "");
    }

    const agentsById: Record<string, { id: string; name: string | null; status: string }> = {};
    for (const agent of companyAgents) agentsById[agent.id] = agent;

    const stagesByPipelineId = new Map<string, Array<{ key: string; name: string }>>();
    for (const stage of companyStages) {
      const list = stagesByPipelineId.get(stage.pipelineId) ?? [];
      list.push({ key: stage.key, name: stage.name });
      stagesByPipelineId.set(stage.pipelineId, list);
    }
    const pipelinesById: Record<string, { id: string; name: string; stages: Array<{ key: string; name: string }> }> = {};
    for (const p of companyPipelines) {
      pipelinesById[p.id] = { id: p.id, name: p.name, stages: stagesByPipelineId.get(p.id) ?? [] };
    }

    const healthStages: PipelineHealthStageInput[] = stages.map((stage) => {
      const stageWithAutomation = withDerivedStageAutomation(stage, routineById);
      const automation = (stageWithAutomation.config as { automation?: { instructionsBody?: string | null } }).automation;
      return {
        id: stage.id,
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
        config: (stageWithAutomation.config ?? null) as Record<string, unknown> | null,
        instructionsBody: automation?.instructionsBody ?? bodyByStageId.get(stage.id) ?? "",
      };
    });
    const failedAutomations: PipelineHealthFailedAutomationInput[] = failedAutomationRows.map((row) => ({
      stageId: row.stageId,
      stageKey: row.stageKey,
      stageName: row.stageName,
      caseId: row.caseId,
      caseTitle: row.caseTitle,
      error: row.error,
    }));

    res.json(computePipelineHealth({ pipelineId, stages: healthStages, agentsById, pipelinesById, failedAutomations }));
  });

  router.get("/pipelines/:pipelineId/intake-form", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    await assertPipelineAccess(db, req, pipelineId);
    const firstStage = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    res.json({
      pipelineId,
      stageId: firstStage?.id ?? null,
      stageName: firstStage?.name ?? null,
      fields: extractIntakeFormFields(firstStage),
    });
  });

  router.patch("/pipelines/:pipelineId", validate(updatePipelineSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    actorForMutation(req);
    const patch: Partial<typeof pipelines.$inferInsert> = { updatedAt: new Date() };
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.description !== undefined) patch.description = req.body.description;
    if (req.body.enforceTransitions !== undefined) patch.enforceTransitions = req.body.enforceTransitions;
    if (req.body.archived !== undefined) patch.archivedAt = req.body.archived ? new Date() : null;
    const [updated] = await db
      .update(pipelines)
      .set(patch)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)))
      .returning();
    res.json(updated);
  });

  router.post("/pipelines/:pipelineId/stages", validate(createStageSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    try {
      const stage = await svc.createStage({
        companyId,
        pipelineId,
        key: req.body.key,
        name: req.body.name,
        kind: req.body.kind,
        position: req.body.position,
        config: req.body.config,
        actor,
      });
      res.status(201).json(stage);
    } catch (error) {
      codedConflictForUnique(error);
    }
  });

  router.patch("/pipelines/:pipelineId/stages/:stageId", validate(updateStageSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    try {
      res.json(await svc.updateStage({ companyId, pipelineId, stageId, patch: req.body, actor }));
    } catch (error) {
      codedConflictForUnique(error);
    }
  });

  router.delete("/pipelines/:pipelineId/stages/:stageId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    const result = await svc.deleteStage({
      companyId,
      pipelineId,
      stageId,
      moveCasesToStageId: typeof req.query.moveCasesToStageId === "string" ? req.query.moveCasesToStageId : null,
      actor,
    });
    res.json(result);
  });

  router.put("/pipelines/:pipelineId/transitions", validate(replaceTransitionsSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    actorForMutation(req);
    const byKey = await getStagesByKey(db, pipelineId);
    const transitions = req.body.transitions.map((edge: z.infer<typeof replaceTransitionsSchema>["transitions"][number]) => {
      const from = byKey.get(edge.fromStageKey);
      const to = byKey.get(edge.toStageKey);
      if (!from || !to) throw unprocessable("Transition references unknown stage", { code: "validation" });
      return { pipelineId, fromStageId: from.id, toStageId: to.id, label: edge.label ?? null };
    });
    const result = await db.transaction(async (tx) => {
      await tx.delete(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, pipelineId));
      if (req.body.enforceTransitions !== undefined) {
        await tx.update(pipelines).set({ enforceTransitions: req.body.enforceTransitions, updatedAt: new Date() })
          .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)));
      }
      return transitions.length ? tx.insert(pipelineTransitions).values(transitions).returning() : [];
    });
    res.json({ transitions: result });
  });

  router.get("/pipelines/:pipelineId/documents/:key", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const row = await getPipelineDocumentRow(db, { companyId, pipelineId, key });
    if (!row) throw notFound("Pipeline document not found");
    res.json(row);
  });

  router.put("/pipelines/:pipelineId/documents/:key", validate(upsertPipelineDocumentSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ link: pipelineDocuments, document: documents, revision: documentRevisions })
        .from(pipelineDocuments)
        .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(eq(pipelineDocuments.companyId, companyId), eq(pipelineDocuments.pipelineId, pipelineId), eq(pipelineDocuments.key, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing && req.body.baseRevisionId && req.body.baseRevisionId !== existing.document.latestRevisionId) {
        throw conflict("Pipeline document was updated by someone else", {
          code: "stale_base_revision",
          latestRevision: existing.revision
            ? {
                id: existing.revision.id,
                revisionNumber: existing.revision.revisionNumber,
                title: existing.revision.title,
                createdAt: existing.revision.createdAt,
                createdByAgentId: existing.revision.createdByAgentId,
                createdByUserId: existing.revision.createdByUserId,
              }
            : null,
          latestRevisionId: existing.document.latestRevisionId,
          latestRevisionNumber: existing.document.latestRevisionNumber,
        });
      }

      if (!existing && req.body.baseRevisionId) {
        throw conflict("Pipeline document does not exist yet", {
          code: "stale_base_revision",
          latestRevision: null,
          latestRevisionId: null,
          latestRevisionNumber: null,
        });
      }

      const now = new Date();
      const [document] = existing
        ? await tx.update(documents).set({
          title: req.body.title ?? key,
          updatedAt: now,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
        }).where(eq(documents.id, existing.document.id)).returning()
        : await tx.insert(documents).values({
          companyId,
          title: req.body.title ?? key,
          latestBody: req.body.body,
          latestRevisionNumber: 1,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "user" ? actor.userId : null,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
        }).returning();
      const [revision] = await tx.insert(documentRevisions).values({
        companyId,
        documentId: document!.id,
        revisionNumber: existing ? existing.document.latestRevisionNumber + 1 : 1,
        title: req.body.title ?? document!.title,
        body: req.body.body,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
        createdByRunId: actor.type === "agent" ? actor.runId : null,
        createdAt: now,
      }).returning();
      await tx.update(documents).set({
        latestBody: req.body.body,
        latestRevisionId: revision!.id,
        latestRevisionNumber: revision!.revisionNumber,
        updatedAt: now,
        updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
        updatedByUserId: actor.type === "user" ? actor.userId : null,
      }).where(eq(documents.id, document!.id));
      if (!existing) {
        await tx.insert(pipelineDocuments).values({ companyId, pipelineId, documentId: document!.id, key, createdAt: now, updatedAt: now });
      } else {
        await tx.update(pipelineDocuments).set({ updatedAt: now }).where(eq(pipelineDocuments.documentId, document!.id));
      }
      return {
        document: {
          ...document!,
          latestBody: req.body.body,
          latestRevisionId: revision!.id,
          latestRevisionNumber: revision!.revisionNumber,
          updatedAt: now,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
        },
        revision,
      };
    });
    res.json(result);
  });

  router.get("/pipelines/:pipelineId/documents/:key/revisions", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const revisions = await listPipelineDocumentRevisions(db, { companyId, pipelineId, key });
    res.json(revisions);
  });

  router.post("/pipelines/:pipelineId/documents/:key/revisions/:revisionId/restore", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const revisionId = req.params.revisionId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ link: pipelineDocuments, document: documents, revision: documentRevisions })
        .from(pipelineDocuments)
        .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(eq(pipelineDocuments.companyId, companyId), eq(pipelineDocuments.pipelineId, pipelineId), eq(pipelineDocuments.key, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Pipeline document not found");

      const sourceRevision = await tx
        .select()
        .from(documentRevisions)
        .where(and(eq(documentRevisions.id, revisionId), eq(documentRevisions.documentId, existing.document.id)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceRevision) throw notFound("Pipeline document revision not found");

      if (existing.document.latestRevisionId === sourceRevision.id) {
        throw conflict("Selected revision is already the latest revision", {
          currentRevisionId: existing.document.latestRevisionId,
        });
      }

      const now = new Date();
      const nextRevisionNumber = existing.document.latestRevisionNumber + 1;
      const [restoredRevision] = await tx.insert(documentRevisions).values({
        companyId,
        documentId: existing.document.id,
        revisionNumber: nextRevisionNumber,
        title: sourceRevision.title ?? null,
        format: sourceRevision.format,
        body: sourceRevision.body,
        changeSummary: `Restored from revision ${sourceRevision.revisionNumber}`,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
        createdByRunId: actor.type === "agent" ? actor.runId : null,
        createdAt: now,
      }).returning();

      const [document] = await tx.update(documents).set({
        title: sourceRevision.title ?? null,
        format: sourceRevision.format,
        latestBody: sourceRevision.body,
        latestRevisionId: restoredRevision!.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
        updatedByUserId: actor.type === "user" ? actor.userId : null,
        updatedAt: now,
      }).where(eq(documents.id, existing.document.id)).returning();

      await tx.update(pipelineDocuments).set({ updatedAt: now }).where(eq(pipelineDocuments.documentId, existing.document.id));

      return {
        document: { ...document!, latestRevisionId: restoredRevision!.id },
        revision: restoredRevision!,
        restoredFromRevisionId: sourceRevision.id,
        restoredFromRevisionNumber: sourceRevision.revisionNumber,
      };
    });

    res.json(result);
  });

  router.post("/pipelines/:pipelineId/cases", validate(ingestCaseSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    const result = await svc.ingestCase({ companyId, pipelineId, ...req.body, actor });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/pipelines/:pipelineId/cases/batch", validate(batchIngestSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    res.json(await svc.ingestCases({ companyId, pipelineId, items: req.body.items, actor }));
  });

  router.get("/pipelines/:pipelineId/cases", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const stageKey = typeof req.query.stageKey === "string" ? req.query.stageKey : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const terminal = req.query.terminal === "true" ? true : req.query.terminal === "false" ? false : undefined;
    const parentCaseId = typeof req.query.parentCaseId === "string" ? req.query.parentCaseId : undefined;
    const rows = await db
      .select({ case: pipelineCases, stage: pipelineStages })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.pipelineId, pipelineId),
        stageKey ? eq(pipelineStages.key, stageKey) : undefined,
        parentCaseId ? eq(pipelineCases.parentCaseId, parentCaseId) : undefined,
        terminal === true ? isNotNull(pipelineCases.terminalKind) : terminal === false ? isNull(pipelineCases.terminalKind) : undefined,
        q ? or(ilike(pipelineCases.title, `%${q}%`), ilike(pipelineCases.summary, `%${q}%`)) : undefined,
      ))
      .orderBy(asc(pipelineCases.createdAt));
    const activeWork = await loadActiveWorkForCases(db, companyId, rows.map((row) => row.case.id));
    res.json(rows.map((row) => ({ ...row, activeWork: activeWork.get(row.case.id) ?? null })));
  });

  router.get("/cases/:caseId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const detail = await getCaseDetail(db, companyId, caseId);
    res.json(detail);
  });

  // Direct children of a case, scoped by parent rather than pipeline. Children can be
  // parented across pipelines (release -> feature -> content trees), so this must not
  // filter by a single pipelineId the way GET /pipelines/:pipelineId/cases does — that
  // filter hides cross-pipeline children even though childCount counts them.
  router.get("/cases/:caseId/children", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const rows = await db
      .select({ case: pipelineCases, stage: pipelineStages })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.parentCaseId, caseId),
      ))
      .orderBy(asc(pipelineCases.createdAt));
    const activeWork = await loadActiveWorkForCases(db, companyId, rows.map((row) => row.case.id));
    res.json(rows.map((row) => ({ ...row, activeWork: activeWork.get(row.case.id) ?? null })));
  });

  router.patch("/cases/:caseId", validate(casePatchSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const updated = await svc.patchCaseContent({ companyId, caseId, ...req.body, actor });
    if (req.body.workspaceRef !== undefined) {
      const [withWorkspace] = await db.update(pipelineCases)
        .set({ workspaceRef: req.body.workspaceRef, updatedAt: new Date() })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      res.json(withWorkspace);
      return;
    }
    res.json(updated);
  });

  router.post("/cases/:caseId/claim", validate(claimCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    if (actor.type === "system") throw forbidden();
    const claimed = await svc.claimCase({ companyId, caseId, actor, leaseMs: req.body.leaseSeconds ? req.body.leaseSeconds * 1000 : undefined });
    res.json({ case: claimed, leaseToken: claimed.leaseToken, leaseExpiresAt: claimed.leaseExpiresAt });
  });

  router.post("/cases/:caseId/release", validate(releaseCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    if (req.body.force && actor.type === "agent") throw new HttpError(403, "Agents cannot force-release pipeline leases", { code: "forbidden" });
    res.json(await svc.releaseCase({ companyId, caseId, actor, leaseToken: req.body.leaseToken, force: req.body.force }));
  });

  router.post("/cases/:caseId/transition", validate(transitionCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.transitionCase({
      companyId,
      caseId,
      toStageKey: req.body.toStageKey,
      expectedVersion: req.body.expectedVersion,
      leaseToken: req.body.leaseToken,
      reason: req.body.reason,
      force: req.body.force,
      suggestionId: req.body.acceptSuggestionId,
      actor,
    }));
  });

  router.post("/cases/:caseId/suggest-transition", validate(suggestTransitionSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.suggestTransition({ companyId, caseId, ...req.body, actor }));
  });

  router.post("/cases/:caseId/resolve-suggestion", validate(resolveSuggestionSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.resolveSuggestion({
      companyId,
      caseId,
      suggestionId: req.body.suggestionId,
      decision: req.body.resolution,
      expectedVersion: req.body.expectedVersion,
      reason: req.body.reason,
      leaseToken: req.body.leaseToken,
      actor,
    }));
  });

  router.post("/cases/:caseId/acknowledge-drift", validate(acknowledgeDriftSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.acknowledgeDrift({
      companyId,
      caseId,
      expectedVersion: req.body.expectedVersion,
      actor,
    }));
  });

  router.post("/cases/:caseId/review", validate(reviewCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.reviewCase({ companyId, caseId, ...req.body, actor }));
  });

  router.put("/cases/:caseId/blockers", validate(blockersSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.replaceBlockers({ companyId, caseId, blockedByCaseIds: req.body.blockedByCaseIds, actor }));
  });

  router.post("/cases/:caseId/open-conversation", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const existing = await db
      .select({ issue: issueRows, link: pipelineCaseIssueLinks })
      .from(pipelineCaseIssueLinks)
      .innerJoin(issueRows, eq(pipelineCaseIssueLinks.issueId, issueRows.id))
      .where(and(
        eq(pipelineCaseIssueLinks.companyId, companyId),
        eq(pipelineCaseIssueLinks.caseId, caseId),
        eq(pipelineCaseIssueLinks.role, "conversation"),
        isNull(issueRows.completedAt),
        isNull(issueRows.cancelledAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      res.json({ issue: existing.issue, created: false });
      return;
    }
    const detail = await getCaseDetail(db, companyId, caseId);
    const result = await db.transaction(async (tx) => {
      const [issue] = await tx.insert(issueRows).values({
        companyId,
        title: `Discuss: ${detail.case.title}`,
        description: buildCaseContextMarkdown(detail),
        status: "todo",
        priority: "medium",
        originKind: "pipeline_case_conversation",
        originId: detail.case.id,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
      }).returning();
      await tx.insert(pipelineCaseIssueLinks).values({
        companyId,
        caseId,
        issueId: issue!.id,
        role: "conversation",
        createdByRunId: actor.type === "agent" ? actor.runId : null,
      });
      await writeRouteEvent(tx, {
        companyId,
        caseId,
        type: "conversation_opened",
        actor,
        payload: { issueId: issue!.id },
      });
      return issue!;
    });
    res.status(201).json({ issue: result, created: true });
  });

  router.get("/cases/:caseId/issue-links", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const links = await db
      .select({ link: pipelineCaseIssueLinks, issue: issueRows })
      .from(pipelineCaseIssueLinks)
      .innerJoin(issueRows, eq(pipelineCaseIssueLinks.issueId, issueRows.id))
      .where(and(
        eq(pipelineCaseIssueLinks.companyId, companyId),
        eq(pipelineCaseIssueLinks.caseId, caseId),
        eq(issueRows.companyId, companyId),
      ))
      .orderBy(asc(pipelineCaseIssueLinks.createdAt));
    res.json(links);
  });

  router.post("/cases/:caseId/issue-links", validate(createIssueLinkSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const targetIssue = await getIssueMutationTarget(db, { companyId, issueId: req.body.issueId });
    if (!targetIssue) throw notFound("Issue not found");
    await assertIssueLinkMutationAllowed(req, { access, issuesSvc, issue: targetIssue });
    try {
      const link = await db.transaction(async (tx) => {
        const [created] = await tx.insert(pipelineCaseIssueLinks).values({
          companyId,
          caseId,
          issueId: req.body.issueId,
          role: req.body.role,
          createdByRunId: actor.type === "agent" ? actor.runId : null,
        }).returning();
        await writeRouteEvent(tx, {
          companyId,
          caseId,
          type: "issue_linked",
          actor,
          payload: { issueId: req.body.issueId, role: req.body.role },
        });
        return created!;
      });
      res.status(201).json(link);
    } catch (error) {
      codedConflictForUnique(error);
    }
  });

  router.delete("/cases/:caseId/issue-links/:linkId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const linkId = req.params.linkId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const existingLink = await db
      .select({ issueId: pipelineCaseIssueLinks.issueId })
      .from(pipelineCaseIssueLinks)
      .where(and(
        eq(pipelineCaseIssueLinks.id, linkId),
        eq(pipelineCaseIssueLinks.companyId, companyId),
        eq(pipelineCaseIssueLinks.caseId, caseId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingLink) throw notFound("Pipeline case issue link not found");
    const targetIssue = await getIssueMutationTarget(db, { companyId, issueId: existingLink.issueId });
    if (!targetIssue) throw notFound("Issue not found");
    await assertIssueLinkMutationAllowed(req, { access, issuesSvc, issue: targetIssue });
    const deleted = await db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(pipelineCaseIssueLinks)
        .where(and(
          eq(pipelineCaseIssueLinks.id, linkId),
          eq(pipelineCaseIssueLinks.companyId, companyId),
          eq(pipelineCaseIssueLinks.caseId, caseId),
        ))
        .returning();
      if (!removed) return null;
      await writeRouteEvent(tx, {
        companyId,
        caseId,
        type: "issue_unlinked",
        actor,
        payload: { issueId: removed.issueId, role: removed.role, linkId: removed.id },
        });
      return removed;
    });
    res.json({ deleted: true });
  });

  router.get("/cases/:caseId/events", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const pagination = parseCaseEventsQuery(req.query);
    res.json(await svc.listCaseEventsPage(companyId, caseId, pagination));
  });

  router.get("/cases/:caseId/children", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    res.json(await getCaseChildrenTree(db, companyId, caseId));
  });

  router.get("/cases/:caseId/rollup", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    res.json(await svc.getCaseRollup(companyId, caseId));
  });

  router.get("/cases/:caseId/context-pack", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const detail = await getCaseDetail(db, companyId, caseId);
    const events = await svc.listCaseEventsPage(companyId, caseId, {
      limit: PIPELINE_CONTEXT_PACK_EVENT_LIMIT,
      order: "desc",
    });
    res.json({
      case: {
        id: detail.case.id,
        caseKey: detail.case.caseKey,
        title: detail.case.title,
        version: detail.case.version,
        untrustedContent: {
          summary: detail.case.summary,
          fields: detail.case.fields,
        },
      },
      stage: detail.stage,
      allowedTransitions: detail.allowedNextStages,
      linkedIssues: detail.links,
      blockers: detail.blockers,
      events: [...events.items].reverse(),
    });
  });

  router.post("/cases/:caseId/automations/:automationId/retry", async (req, res) => {
    const caseId = req.params.caseId as string;
    const automationId = req.params.automationId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    res.json(await svc.retryAutomation({ companyId, caseId, automationId, actor }));
  });

  return router;
}

async function getCaseDetail(db: Db, companyId: string, caseId: string) {
  const row = await db
    .select({ case: pipelineCases, stage: pipelineStages, pipeline: pipelines })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  const parentCasePromise = row.case.parentCaseId
    ? db
      .select({ case: pipelineCases, stage: pipelineStages, pipeline: pipelines })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
      .where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.id, row.case.parentCaseId),
        eq(pipelines.companyId, companyId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : Promise.resolve(null);
  const [allowedNextStages, links, blockers, blocks, childrenCounts, activeWorkByCase, parentCase] = await Promise.all([
    db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, row.case.pipelineId)).orderBy(asc(pipelineStages.position)),
    db.select().from(pipelineCaseIssueLinks).where(and(eq(pipelineCaseIssueLinks.companyId, companyId), eq(pipelineCaseIssueLinks.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.blockedByCaseId, caseId))),
    getDirectChildrenSummary(db, companyId, caseId),
    loadActiveWorkForCases(db, companyId, [caseId]),
    parentCasePromise,
  ]);
  return {
    ...row,
    // Derived, invisible: a case's "type" is simply which pipeline it lives in.
    // Used internally for display and ingest sanity-checks; not a user field.
    caseType: deriveCaseType(row.pipeline),
    allowedNextStages,
    links,
    blockers,
    blocks,
    childrenSummary: {
      childCount: row.case.childCount,
      terminalChildCount: row.case.terminalChildCount,
      loadedChildren: childrenCounts.total,
      ...childrenCounts,
    },
    activeWork: activeWorkByCase.get(caseId) ?? null,
    parentCase,
    pendingSuggestion: row.case.pendingSuggestion,
  };
}

function buildCaseContextMarkdown(detail: Awaited<ReturnType<typeof getCaseDetail>>) {
  return [
    "## Pipeline Item Context",
    "",
    `Item: ${detail.case.title}`,
    `Pipeline: ${detail.pipeline.name} (${detail.pipeline.key})`,
    `Stage: ${detail.stage.name} (${detail.stage.key}, ${detail.stage.kind})`,
    `Item link: /PAP/pipelines/${detail.pipeline.id}/cases/${detail.case.id}`,
    "",
    "```json",
    JSON.stringify({
      pipeline: {
        id: detail.pipeline.id,
        key: detail.pipeline.key,
        name: detail.pipeline.name,
      },
      case: {
        id: detail.case.id,
        caseKey: detail.case.caseKey,
        title: detail.case.title,
        version: detail.case.version,
        untrustedContent: {
          summary: detail.case.summary,
          fields: detail.case.fields,
        },
      },
      stage: {
        id: detail.stage.id,
        key: detail.stage.key,
        name: detail.stage.name,
        kind: detail.stage.kind,
      },
    }, null, 2),
    "```",
  ].join("\n");
}
