import { Router, type Request } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documents,
  documentRevisions,
  heartbeatRuns,
  issueDocuments,
  issues as issueRows,
  issueRelations,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseDocuments,
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
  ensurePipelineCaseBodyDocumentFromSummary,
  pipelineService,
  resolvePipelineCaseConversationSource,
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
  loadDescendantActiveWorkCountsForCases,
  listCompanyCaseEvents,
  listPipelineAttention,
  loadActiveWorkForCases,
  loadPipelineDescendantActiveWorkCounts,
  loadPipelineConnections,
  PIPELINE_ATTENTION_DEFAULT_LIMIT,
  PIPELINE_ATTENTION_MAX_LIMIT,
  type AttentionCaller,
} from "../services/pipelines-aggregation.js";
import { accessService } from "../services/access.js";
import { authorizationService } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { assertCompanyAccess } from "./authz.js";
import {
  computePipelineHealth,
  deriveCaseType,
  envConfigSchema,
  issueDocumentKeySchema,
  PIPELINE_CASE_BODY_DOCUMENT_KEY,
  pipelineAutomationRetryRequestSchema,
  pipelineAutomationRetryScopeSchema,
  type PipelineStageAutomation,
  type PipelineCaseLiveness,
  type PipelineHealthFailedAutomationInput,
  type PipelineHealthStageInput,
} from "@paperclipai/shared";
import { documentAnnotationService } from "../services/document-annotations.js";
import { logActivity } from "../services/activity-log.js";
import {
  formatPipelineConversationBodyDocumentContextMarkdown,
  loadPipelineConversationBodyDocumentContext,
} from "../services/pipeline-conversation-context.js";
import { resolveActorSourceTrustForIssue } from "../services/source-trust.js";
import {
  formatPipelineCaseOutputContextMarkdown,
  pipelineCaseOutputsService,
  summarizePipelineCaseOutputsForContext,
} from "../services/pipeline-case-outputs.js";

/** Per-stage instructions document keys look like `stage-instructions:{stageId}`. */
const STAGE_INSTRUCTIONS_PREFIX = "stage-instructions:";
type PipelineRouteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
const updateStageAutomationEnvSchema = z.object({
  env: envConfigSchema.nullable(),
  baseRoutineRevisionId: z.string().uuid().nullable().optional(),
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
const breakdownCaseSchema = z.object({
  items: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    summary: z.string().max(8_000).nullable().optional(),
    fields: jsonObjectSchema.optional(),
  })).max(200),
});
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
const retryAutomationQuerySchema = z.object({
  scope: pipelineAutomationRetryScopeSchema.default("previous_stage"),
  targetStageId: z.string().uuid().optional(),
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
const upsertPipelineCaseDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional().default("markdown"),
  body: z.string().max(200_000),
  changeSummary: z.string().trim().max(1_000).nullable().optional(),
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

function readAutomationContextValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stageAutomationContext(config: Record<string, unknown>) {
  const onEnter = config.onEnter;
  const record = onEnter && typeof onEnter === "object" && !Array.isArray(onEnter)
    ? onEnter as Record<string, unknown>
    : {};
  return {
    projectId: readAutomationContextValue(record.projectId),
    projectWorkspaceId: readAutomationContextValue(record.projectWorkspaceId),
    executionWorkspaceId: readAutomationContextValue(record.executionWorkspaceId),
    executionWorkspacePreference: readAutomationContextValue(record.executionWorkspacePreference),
    executionWorkspaceSettings:
      record.executionWorkspaceSettings && typeof record.executionWorkspaceSettings === "object" && !Array.isArray(record.executionWorkspaceSettings)
        ? record.executionWorkspaceSettings
        : null,
  };
}

function withDerivedStageAutomation(
  stage: typeof pipelineStages.$inferSelect,
  routineById: Map<string, {
    assigneeAgentId: string | null;
    description: string | null;
    env: PipelineStageAutomation["env"];
    latestRevisionId: string | null;
    latestRevisionNumber: number;
  }>,
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
        routineId,
        assigneeAgentId: routine.assigneeAgentId,
        instructionsBody: routine.description ?? "",
        ...stageAutomationContext(config),
        env: routine.env ?? null,
        latestRoutineRevisionId: routine.latestRevisionId,
        latestRoutineRevisionNumber: routine.latestRevisionNumber,
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

async function assertPipelineWriteAccess(
  req: Request,
  input: {
    access: ReturnType<typeof accessService>;
    companyId: string;
    pipelineId: string;
  },
) {
  assertPipelineCompanyAccess(req, input.companyId);
  const decision = await input.access.decide({
    actor: req.actor,
    action: "pipelines:write",
    resource: { type: "company", companyId: input.companyId },
    scope: { pipelineId: input.pipelineId },
  });
  if (!decision.allowed) {
    throw new HttpError(403, decision.explanation, {
      code: "pipeline_write_forbidden",
      reason: decision.reason,
      pipelineId: input.pipelineId,
    });
  }
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

function parseDocumentKey(rawKey: unknown) {
  const parsed = issueDocumentKeySchema.safeParse(String(rawKey ?? "").trim().toLowerCase());
  if (!parsed.success) {
    throw badRequest("Invalid document key", parsed.error.issues);
  }
  return parsed.data;
}

function mapPipelineCaseDocumentRevision(row: {
  id: string;
  companyId: string;
  documentId: string;
  caseId: string;
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

async function getPipelineCaseDocumentRow(db: PipelineRouteDb, input: { companyId: string; caseId: string; key: string }) {
  return db
    .select({ link: pipelineCaseDocuments, document: documents, revision: documentRevisions })
    .from(pipelineCaseDocuments)
    .innerJoin(documents, eq(pipelineCaseDocuments.documentId, documents.id))
    .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
    .where(and(
      eq(pipelineCaseDocuments.companyId, input.companyId),
      eq(pipelineCaseDocuments.caseId, input.caseId),
      eq(pipelineCaseDocuments.key, input.key),
    ))
    .limit(1)
    .then((rows: Array<{ link: typeof pipelineCaseDocuments.$inferSelect; document: typeof documents.$inferSelect; revision: typeof documentRevisions.$inferSelect | null }>) => rows[0] ?? null);
}

async function listPipelineCaseDocumentRevisions(db: Db, input: { companyId: string; caseId: string; key: string }) {
  return db
    .select({
      id: documentRevisions.id,
      companyId: documentRevisions.companyId,
      documentId: documentRevisions.documentId,
      caseId: pipelineCaseDocuments.caseId,
      key: pipelineCaseDocuments.key,
      revisionNumber: documentRevisions.revisionNumber,
      title: documentRevisions.title,
      format: documentRevisions.format,
      body: documentRevisions.body,
      changeSummary: documentRevisions.changeSummary,
      createdByAgentId: documentRevisions.createdByAgentId,
      createdByUserId: documentRevisions.createdByUserId,
      createdAt: documentRevisions.createdAt,
    })
    .from(pipelineCaseDocuments)
    .innerJoin(documents, eq(pipelineCaseDocuments.documentId, documents.id))
    .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
    .where(and(
      eq(pipelineCaseDocuments.companyId, input.companyId),
      eq(pipelineCaseDocuments.caseId, input.caseId),
      eq(pipelineCaseDocuments.key, input.key),
    ))
    .orderBy(desc(documentRevisions.revisionNumber))
    .then((rows) => rows.map(mapPipelineCaseDocumentRevision));
}

async function resolveCasePipelineId(db: Db, input: { companyId: string; caseId: string }) {
  const row = await db
    .select({ pipelineId: pipelineCases.pipelineId })
    .from(pipelineCases)
    .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.id, input.caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  return row.pipelineId;
}

function activityActorForPipelineRoute(actor: PipelineActor) {
  if (actor.type === "agent") {
    return { actorType: "agent" as const, actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId };
  }
  if (actor.type === "user") {
    return { actorType: "user" as const, actorId: actor.userId, agentId: null, runId: null };
  }
  return { actorType: "system" as const, actorId: "pipeline", agentId: null, runId: null };
}

function issueIdFromPipelineRouteRunContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  const issueId = context.issueId ?? context.taskId;
  return typeof issueId === "string" && issueId.trim().length > 0 ? issueId.trim() : null;
}

async function sourceTrustForPipelineCaseDocumentWrite(
  dbOrTx: Db | any,
  input: {
    companyId: string;
    caseId: string;
    actor: PipelineActor;
  },
) {
  if (input.actor.type !== "agent") return null;

  const conversationSource = await resolvePipelineCaseConversationSource(dbOrTx, input.companyId, input.caseId);
  let issue = conversationSource?.isActive ? conversationSource.issue : null;

  if (!issue) {
    const runIssueId = await dbOrTx
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.id, input.actor.runId),
        eq(heartbeatRuns.agentId, input.actor.agentId),
      ))
      .limit(1)
      .then((rows: Array<{ contextSnapshot: unknown }>) =>
        issueIdFromPipelineRouteRunContext(rows[0]?.contextSnapshot),
      );

    issue = runIssueId
      ? await dbOrTx
          .select()
          .from(issueRows)
          .where(and(eq(issueRows.companyId, input.companyId), eq(issueRows.id, runIssueId)))
          .limit(1)
          .then((rows: Array<typeof issueRows.$inferSelect>) => rows[0] ?? null)
      : null;
  }

  if (!issue) return null;

  return resolveActorSourceTrustForIssue({
    db: dbOrTx as Db,
    issue: {
      id: issue.id,
      companyId: issue.companyId,
      projectId: issue.projectId,
      executionPolicy: issue.executionPolicy,
    },
    actor: {
      actorType: "agent",
      actorId: input.actor.agentId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
    },
  });
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
  const outputsSvc = pipelineCaseOutputsService(db);
  const access = accessService(db);
  const issuesSvc = issueService(db);
  const documentAnnotationsSvc = documentAnnotationService(db);

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
    const pipelineIds = rows.map((row) => row.pipeline.id);
    const [connections, descendantActiveWorkCounts, stageRows] = await Promise.all([
      loadPipelineConnections(db, companyId),
      loadPipelineDescendantActiveWorkCounts(db, companyId, pipelineIds),
      pipelineIds.length > 0
        ? db
        .select()
        .from(pipelineStages)
        .where(inArray(pipelineStages.pipelineId, pipelineIds))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
        : Promise.resolve([]),
    ]);
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
      descendantActiveWorkCount: descendantActiveWorkCounts.get(row.pipeline.id) ?? 0,
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
    const decision = await access.decide({
      actor: req.actor,
      action: "pipelines:write",
      resource: { type: "company", companyId },
      scope: null,
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.explanation, {
        code: "pipeline_write_forbidden",
        reason: decision.reason,
      });
    }
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
          .select({
            id: routines.id,
            assigneeAgentId: routines.assigneeAgentId,
            description: routines.description,
            env: routines.env,
            latestRevisionId: routines.latestRevisionId,
            latestRevisionNumber: routines.latestRevisionNumber,
          })
          .from(routines)
          .where(and(eq(routines.companyId, companyId), inArray(routines.id, automationRoutineIds)))
      : [];
    const routineById = new Map(routineRows.map((row) => [
      row.id,
      {
        assigneeAgentId: row.assigneeAgentId,
        description: row.description,
        env: row.env,
        latestRevisionId: row.latestRevisionId,
        latestRevisionNumber: row.latestRevisionNumber,
      },
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
      db.select({
        pipelineId: pipelineStages.pipelineId,
        key: pipelineStages.key,
        name: pipelineStages.name,
        kind: pipelineStages.kind,
        config: pipelineStages.config,
      })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
        .where(eq(pipelines.companyId, companyId))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt)),
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
          .select({
            id: routines.id,
            assigneeAgentId: routines.assigneeAgentId,
            description: routines.description,
            env: routines.env,
            latestRevisionId: routines.latestRevisionId,
            latestRevisionNumber: routines.latestRevisionNumber,
          })
          .from(routines)
          .where(and(eq(routines.companyId, companyId), inArray(routines.id, automationRoutineIds)))
      : [];
    const routineById = new Map(routineRows.map((row) => [
      row.id,
      {
        assigneeAgentId: row.assigneeAgentId,
        description: row.description,
        env: row.env,
        latestRevisionId: row.latestRevisionId,
        latestRevisionNumber: row.latestRevisionNumber,
      },
    ]));

    const bodyByStageId = new Map<string, string>();
    for (const doc of instructionDocs) {
      if (!doc.key.startsWith(STAGE_INSTRUCTIONS_PREFIX)) continue;
      bodyByStageId.set(doc.key.slice(STAGE_INSTRUCTIONS_PREFIX.length), doc.body ?? "");
    }

    const agentsById: Record<string, { id: string; name: string | null; status: string }> = {};
    for (const agent of companyAgents) agentsById[agent.id] = agent;

    const stagesByPipelineId = new Map<string, Array<{ key: string; name: string; kind: string; config: Record<string, unknown> | null }>>();
    for (const stage of companyStages) {
      const list = stagesByPipelineId.get(stage.pipelineId) ?? [];
      list.push({
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
        config: (stage.config ?? null) as Record<string, unknown> | null,
      });
      stagesByPipelineId.set(stage.pipelineId, list);
    }
    const pipelinesById: Record<string, { id: string; name: string; stages: Array<{ key: string; name: string; kind: string; config: Record<string, unknown> | null }> }> = {};
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);
    try {
      res.json(await svc.updateStage({ companyId, pipelineId, stageId, patch: req.body, actor }));
    } catch (error) {
      codedConflictForUnique(error);
    }
  });

  router.patch("/pipelines/:pipelineId/stages/:stageId/automation-env", validate(updateStageAutomationEnvSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);
    res.json(await svc.updateStageAutomationEnv({
      companyId,
      pipelineId,
      stageId,
      env: req.body.env,
      baseRoutineRevisionId: req.body.baseRoutineRevisionId ?? null,
      actor,
    }));
  });

  router.delete("/pipelines/:pipelineId/stages/:stageId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
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
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);
    const result = await svc.ingestCase({ companyId, pipelineId, ...req.body, actor });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/pipelines/:pipelineId/cases/batch", validate(batchIngestSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);
    res.json(await svc.ingestCases({ companyId, pipelineId, items: req.body.items, actor }));
  });

  router.post("/cases/:caseId/breakdown", validate(breakdownCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const target = await svc.resolveBreakdownTarget({ companyId, caseId });
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId: target.targetPipeline.id });
    const actor = actorForMutation(req);
    res.json(await svc.breakdownCase({ companyId, caseId, items: req.body.items, actor }));
  });

  router.get("/pipelines/:pipelineId/cases", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const stageKey = typeof req.query.stageKey === "string" ? req.query.stageKey : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const terminal = req.query.terminal === "true" ? true : req.query.terminal === "false" ? false : undefined;
    const includeRetired = req.query.includeRetired === "true";
    const parentCaseId = typeof req.query.parentCaseId === "string" ? req.query.parentCaseId : undefined;
    const parentCase = alias(pipelineCases, "parent_case");
    const parentPipeline = alias(pipelines, "parent_pipeline");
    const rows = await db
      .select({
        case: pipelineCases,
        stage: pipelineStages,
        parentCase: {
          id: parentCase.id,
          caseKey: parentCase.caseKey,
          title: parentCase.title,
          pipelineId: parentCase.pipelineId,
        },
        parentPipeline: {
          id: parentPipeline.id,
          key: parentPipeline.key,
          name: parentPipeline.name,
        },
      })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .leftJoin(parentCase, and(
        eq(parentCase.companyId, companyId),
        eq(parentCase.id, pipelineCases.parentCaseId),
      ))
      .leftJoin(parentPipeline, and(
        eq(parentPipeline.companyId, companyId),
        eq(parentPipeline.id, parentCase.pipelineId),
      ))
      .where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.pipelineId, pipelineId),
        stageKey ? eq(pipelineStages.key, stageKey) : undefined,
        parentCaseId ? eq(pipelineCases.parentCaseId, parentCaseId) : undefined,
        includeRetired ? undefined : isNull(pipelineCases.hiddenFromBoardAt),
        terminal === true ? isNotNull(pipelineCases.terminalKind) : terminal === false ? isNull(pipelineCases.terminalKind) : undefined,
        q ? or(ilike(pipelineCases.title, `%${q}%`), ilike(pipelineCases.summary, `%${q}%`)) : undefined,
      ))
      .orderBy(asc(pipelineCases.createdAt));
    const caseIds = rows.map((row) => row.case.id);
    const [activeWork, descendantActiveWorkCounts] = await Promise.all([
      loadActiveWorkForCases(db, companyId, caseIds),
      loadDescendantActiveWorkCountsForCases(db, companyId, caseIds),
    ]);
    res.json(rows.map((row) => ({
      case: row.case,
      stage: row.stage,
      parentCase: row.parentCase?.id && row.parentPipeline?.id
        ? {
            case: row.parentCase,
            pipeline: row.parentPipeline,
          }
        : null,
      activeWork: activeWork.get(row.case.id) ?? null,
      descendantActiveWorkCount: descendantActiveWorkCounts.get(row.case.id) ?? 0,
    })));
  });

  router.get("/cases/:caseId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const detail = await getCaseDetail(db, companyId, caseId);
    res.json(detail);
  });

  router.get("/cases/:caseId/documents/:key", async (req, res) => {
    const caseId = req.params.caseId as string;
    const key = parseDocumentKey(req.params.key);
    const companyId = await assertCaseAccess(db, req, caseId);
    const row = await db.transaction(async (tx) => {
      const existing = await getPipelineCaseDocumentRow(tx, { companyId, caseId, key });
      if (existing || key !== "body") return existing;
      const caseRow = await tx
        .select({ summary: pipelineCases.summary })
        .from(pipelineCases)
        .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!caseRow?.summary?.trim()) return null;
      await ensurePipelineCaseBodyDocumentFromSummary(tx, {
        companyId,
        caseId,
        summary: caseRow.summary,
        actor: { type: "system" },
      });
      return getPipelineCaseDocumentRow(tx, { companyId, caseId, key });
    });
    if (!row) throw notFound("Pipeline case document not found");
    res.json(row);
  });

  router.put("/cases/:caseId/documents/:key", validate(upsertPipelineCaseDocumentSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const key = parseDocumentKey(req.params.key);
    const companyId = await assertCaseAccess(db, req, caseId);
    const pipelineId = await resolveCasePipelineId(db, { companyId, caseId });
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);
    const sourceTrust = await sourceTrustForPipelineCaseDocumentWrite(db, { companyId, caseId, actor });

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ link: pipelineCaseDocuments, document: documents, revision: documentRevisions })
        .from(pipelineCaseDocuments)
        .innerJoin(documents, eq(pipelineCaseDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(
          eq(pipelineCaseDocuments.companyId, companyId),
          eq(pipelineCaseDocuments.caseId, caseId),
          eq(pipelineCaseDocuments.key, key),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing && !req.body.baseRevisionId) {
        throw conflict("Pipeline case document update requires baseRevisionId", {
          code: "stale_base_revision",
          latestRevisionId: existing.document.latestRevisionId,
          latestRevisionNumber: existing.document.latestRevisionNumber,
        });
      }
      if (existing && req.body.baseRevisionId !== existing.document.latestRevisionId) {
        throw conflict("Pipeline case document was updated by someone else", {
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
        throw conflict("Pipeline case document does not exist yet", {
          code: "stale_base_revision",
          latestRevision: null,
          latestRevisionId: null,
          latestRevisionNumber: null,
        });
      }

      const now = new Date();
      const [document] = existing
        ? await tx.update(documents).set({
          title: req.body.title ?? existing.document.title,
          format: req.body.format,
          updatedAt: now,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
          sourceTrust,
        }).where(eq(documents.id, existing.document.id)).returning()
        : await tx.insert(documents).values({
          companyId,
          title: req.body.title ?? key,
          format: req.body.format,
          latestBody: req.body.body,
          latestRevisionNumber: 1,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "user" ? actor.userId : null,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
          sourceTrust,
          createdAt: now,
          updatedAt: now,
        }).returning();
      const nextRevisionNumber = existing ? existing.document.latestRevisionNumber + 1 : 1;
      const [revision] = await tx.insert(documentRevisions).values({
        companyId,
        documentId: document!.id,
        revisionNumber: nextRevisionNumber,
        title: req.body.title ?? document!.title,
        format: req.body.format,
        body: req.body.body,
        changeSummary: req.body.changeSummary ?? null,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
        createdByRunId: actor.type === "agent" ? actor.runId : null,
        createdAt: now,
      }).returning();
      await tx.update(documents).set({
        title: req.body.title ?? document!.title,
        format: req.body.format,
        latestBody: req.body.body,
        latestRevisionId: revision!.id,
        latestRevisionNumber: revision!.revisionNumber,
        updatedAt: now,
        updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
        updatedByUserId: actor.type === "user" ? actor.userId : null,
        sourceTrust,
      }).where(eq(documents.id, document!.id));
      if (!existing) {
        await tx.insert(pipelineCaseDocuments).values({ companyId, caseId, documentId: document!.id, key, createdAt: now, updatedAt: now });
      } else {
        await tx.update(pipelineCaseDocuments).set({ updatedAt: now }).where(eq(pipelineCaseDocuments.documentId, document!.id));
      }

      if (key === "body") {
        const conversationSource = await resolvePipelineCaseConversationSource(tx, companyId, caseId);
        if (conversationSource?.isActive) {
          await tx.insert(issueDocuments).values({
            companyId,
            issueId: conversationSource.issue.id,
            documentId: document!.id,
            key: PIPELINE_CASE_BODY_DOCUMENT_KEY,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: [issueDocuments.companyId, issueDocuments.issueId, issueDocuments.key],
            set: { documentId: document!.id, updatedAt: now },
          });
        }
      }

      const linkedIssueDocuments = await tx
        .select({ issueId: issueDocuments.issueId, key: issueDocuments.key })
        .from(issueDocuments)
        .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.documentId, document!.id)));

      return {
        created: !existing,
        document: {
          ...document!,
          title: req.body.title ?? document!.title,
          format: req.body.format,
          latestBody: req.body.body,
          latestRevisionId: revision!.id,
          latestRevisionNumber: revision!.revisionNumber,
          updatedAt: now,
          updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
          updatedByUserId: actor.type === "user" ? actor.userId : null,
          sourceTrust,
        },
        revision,
        linkedIssueDocuments,
      };
    });

    if (!result.created) {
      await Promise.all(result.linkedIssueDocuments.map((link) =>
        documentAnnotationsSvc.remapOpenThreadsForDocument({
          issueId: link.issueId,
          key: link.key,
          documentId: result.document.id,
          nextRevisionId: result.document.latestRevisionId,
          nextRevisionNumber: result.document.latestRevisionNumber,
          nextBody: result.document.latestBody,
        })
      ));
    }
    await logActivity(db, {
      companyId,
      ...activityActorForPipelineRoute(actor),
      action: result.created ? "pipeline.case_document_created" : "pipeline.case_document_updated",
      entityType: "pipeline_case",
      entityId: caseId,
      details: {
        key,
        documentId: result.document.id,
        revisionId: result.revision!.id,
        revisionNumber: result.revision!.revisionNumber,
        linkedIssueIds: result.linkedIssueDocuments.map((link) => link.issueId),
      },
    });
    res.json({ document: result.document, revision: result.revision });
  });

  router.get("/cases/:caseId/documents/:key/revisions", async (req, res) => {
    const caseId = req.params.caseId as string;
    const key = parseDocumentKey(req.params.key);
    const companyId = await assertCaseAccess(db, req, caseId);
    const revisions = await listPipelineCaseDocumentRevisions(db, { companyId, caseId, key });
    res.json(revisions);
  });

  router.post("/cases/:caseId/documents/:key/revisions/:revisionId/restore", async (req, res) => {
    const caseId = req.params.caseId as string;
    const key = parseDocumentKey(req.params.key);
    const revisionId = req.params.revisionId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const pipelineId = await resolveCasePipelineId(db, { companyId, caseId });
    await assertPipelineWriteAccess(req, { access, companyId, pipelineId });
    const actor = actorForMutation(req);

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ link: pipelineCaseDocuments, document: documents, revision: documentRevisions })
        .from(pipelineCaseDocuments)
        .innerJoin(documents, eq(pipelineCaseDocuments.documentId, documents.id))
        .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
        .where(and(
          eq(pipelineCaseDocuments.companyId, companyId),
          eq(pipelineCaseDocuments.caseId, caseId),
          eq(pipelineCaseDocuments.key, key),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Pipeline case document not found");

      const sourceRevision = await tx
        .select()
        .from(documentRevisions)
        .where(and(eq(documentRevisions.id, revisionId), eq(documentRevisions.documentId, existing.document.id)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceRevision) throw notFound("Pipeline case document revision not found");
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
      await tx.update(pipelineCaseDocuments).set({ updatedAt: now }).where(eq(pipelineCaseDocuments.documentId, existing.document.id));

      const linkedIssueDocuments = await tx
        .select({ issueId: issueDocuments.issueId, key: issueDocuments.key })
        .from(issueDocuments)
        .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.documentId, existing.document.id)));

      return {
        document: document!,
        revision: restoredRevision!,
        restoredFromRevisionId: sourceRevision.id,
        restoredFromRevisionNumber: sourceRevision.revisionNumber,
        linkedIssueDocuments,
      };
    });

    await Promise.all(result.linkedIssueDocuments.map((link) =>
      documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: link.issueId,
        key: link.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.latestBody,
      })
    ));
    await logActivity(db, {
      companyId,
      ...activityActorForPipelineRoute(actor),
      action: "pipeline.case_document_restored",
      entityType: "pipeline_case",
      entityId: caseId,
      details: {
        key,
        documentId: result.document.id,
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        restoredFromRevisionId: result.restoredFromRevisionId,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        linkedIssueIds: result.linkedIssueDocuments.map((link) => link.issueId),
      },
    });
    res.json(result);
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
        isNull(pipelineCases.hiddenFromBoardAt),
      ))
      .orderBy(asc(pipelineCases.createdAt));
    const caseIds = rows.map((row) => row.case.id);
    const [activeWork, descendantActiveWorkCounts] = await Promise.all([
      loadActiveWorkForCases(db, companyId, caseIds),
      loadDescendantActiveWorkCountsForCases(db, companyId, caseIds),
    ]);
    res.json(rows.map((row) => ({
      ...row,
      activeWork: activeWork.get(row.case.id) ?? null,
      descendantActiveWorkCount: descendantActiveWorkCounts.get(row.case.id) ?? 0,
    })));
  });

  router.patch("/cases/:caseId", validate(casePatchSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const updated = await svc.patchCaseContent({ companyId, caseId, ...req.body, actor });
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
    const conversationSource = await resolvePipelineCaseConversationSource(db, companyId, caseId);
    if (conversationSource?.isActive) {
      res.json({ issue: conversationSource.issue, created: false });
      return;
    }
    const detail = await getCaseDetail(db, companyId, caseId);
    const [bodyDocumentContext, outputSummaries] = await Promise.all([
      loadPipelineConversationBodyDocumentContext(db, { companyId, caseId }),
      outputsSvc.listCaseOutputs(companyId, caseId).then((outputs) => summarizePipelineCaseOutputsForContext(outputs)),
    ]);
    const result = await db.transaction(async (tx) => {
      const existingConversationSource = await resolvePipelineCaseConversationSource(tx, companyId, caseId);
      if (existingConversationSource?.isActive) {
        return { issue: existingConversationSource.issue, created: false };
      }
      const [issue] = await tx.insert(issueRows).values({
        companyId,
        title: `Discuss: ${detail.case.title}`,
        description: buildCaseContextMarkdown(detail, bodyDocumentContext, outputSummaries),
        status: "todo",
        priority: "medium",
        parentId: existingConversationSource?.issue?.id ?? conversationSource?.issue?.id ?? null,
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
      if (bodyDocumentContext.bodyDocument) {
        await tx.insert(issueDocuments).values({
          companyId,
          issueId: issue!.id,
          documentId: bodyDocumentContext.bodyDocument.id,
          key: PIPELINE_CASE_BODY_DOCUMENT_KEY,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).onConflictDoNothing();
      }
      await writeRouteEvent(tx, {
        companyId,
        caseId,
        type: "conversation_opened",
        actor,
        payload: { issueId: issue!.id },
      });
      return { issue: issue!, created: true };
    });
    res.status(result.created ? 201 : 200).json(result);
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

  router.get("/cases/:caseId/outputs", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    res.json(await outputsSvc.listCaseOutputs(companyId, caseId));
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

  router.get("/cases/:caseId/children/tree", async (req, res) => {
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
    const [events, outputs, childOutcomes] = await Promise.all([
      svc.listCaseEventsPage(companyId, caseId, {
        limit: PIPELINE_CONTEXT_PACK_EVENT_LIMIT,
        order: "desc",
      }),
      outputsSvc.listCaseOutputs(companyId, caseId),
      getChildOutcomeSummaries(db, companyId, caseId),
    ]);
    const outputSummaries = summarizePipelineCaseOutputsForContext(outputs);
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
      childOutcomes,
      outputSummaries,
      events: [...events.items].reverse(),
    });
  });

  router.get("/cases/:caseId/automation/retry-plan", async (req, res) => {
    const caseId = req.params.caseId as string;
    const query = retryAutomationQuerySchema.parse(req.query);
    const companyId = await assertCaseAccess(db, req, caseId);
    const plan = await svc.getAutomationRetryPlan({
      companyId,
      caseId,
      scope: query.scope,
      targetStageId: query.targetStageId,
    });
    if (plan.targetStage) {
      await assertStageAutomationTargetWriteAccess(db, req, { access, companyId, stage: plan.targetStage });
    }
    res.json(plan);
  });

  router.post("/cases/:caseId/automation/retry", validate(pipelineAutomationRetryRequestSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const actor = actorForMutation(req);
    const plan = await svc.getAutomationRetryPlan({
      companyId,
      caseId,
      scope: req.body.scope,
      targetStageId: req.body.targetStageId,
    });
    if (plan.targetStage) {
      await assertStageAutomationTargetWriteAccess(db, req, { access, companyId, stage: plan.targetStage });
    }
    res.json(await svc.retryStageAutomation({
      companyId,
      caseId,
      scope: req.body.scope,
      targetStageId: req.body.targetStageId,
      expectedVersion: req.body.expectedVersion,
      cleanup: req.body.cleanup,
      actor,
    }));
  });

  router.post("/cases/:caseId/automations/:automationId/retry", async (req, res) => {
    const caseId = req.params.caseId as string;
    const automationId = req.params.automationId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    await assertCurrentStageAutomationTargetWriteAccess(db, req, { access, companyId, caseId, automationId });
    const actor = actorForMutation(req);
    res.json(await svc.retryAutomation({ companyId, caseId, automationId, actor }));
  });

  router.post("/cases/:caseId/automation/current-stage/rerun", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    await assertCurrentStageAutomationTargetWriteAccess(db, req, { access, companyId, caseId });
    const actor = actorForMutation(req);
    res.json(await svc.rerunCurrentStageAutomation({ companyId, caseId, actor }));
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
  const [
    allowedNextStages,
    links,
    blockers,
    blocks,
    childrenCounts,
    activeWorkByCase,
    descendantActiveWorkCounts,
    parentCase,
    conversationSource,
    liveness,
    builtFromAutomation,
  ] = await Promise.all([
    db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, row.case.pipelineId)).orderBy(asc(pipelineStages.position)),
    db.select().from(pipelineCaseIssueLinks).where(and(eq(pipelineCaseIssueLinks.companyId, companyId), eq(pipelineCaseIssueLinks.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.blockedByCaseId, caseId))),
    getDirectChildrenSummary(db, companyId, caseId),
    loadActiveWorkForCases(db, companyId, [caseId]),
    loadDescendantActiveWorkCountsForCases(db, companyId, [caseId]),
    parentCasePromise,
    resolvePipelineCaseConversationSource(db, companyId, caseId),
    derivePipelineCaseLiveness(db, companyId, row),
    loadBuiltFromAutomation(db, companyId, row.case),
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
      childCount: childrenCounts.total,
      terminalChildCount: childrenCounts.done + childrenCounts.dropped,
      loadedChildren: childrenCounts.total,
      descendantActiveWorkCount: descendantActiveWorkCounts.get(caseId) ?? 0,
      ...childrenCounts,
    },
    activeWork: activeWorkByCase.get(caseId) ?? null,
    liveness,
    conversationSource,
    builtFromAutomation,
    parentCase,
    pendingSuggestion: row.case.pendingSuggestion,
  };
}

function stageAutomationId(stage: typeof pipelineStages.$inferSelect) {
  const config = stage.config && typeof stage.config === "object" && !Array.isArray(stage.config)
    ? stage.config as PipelineStageConfig
    : null;
  const onEnter = config?.onEnter;
  if (!onEnter || onEnter.type !== "run_routine" || !onEnter.routineId) return null;
  return typeof onEnter.id === "string" ? onEnter.id : `${stage.id}:on_enter`;
}

async function loadBuiltFromAutomation(
  db: Db,
  companyId: string,
  caseRow: typeof pipelineCases.$inferSelect,
) {
  if (!caseRow.automationAttemptId) return null;
  const row = await db
    .select({
      execution: pipelineAutomationExecutions,
      sourceCase: pipelineCases,
      sourcePipeline: pipelines,
      routine: routines,
    })
    .from(pipelineAutomationExecutions)
    .innerJoin(pipelineCases, and(
      eq(pipelineCases.companyId, companyId),
      eq(pipelineCases.id, pipelineAutomationExecutions.caseId),
    ))
    .innerJoin(pipelines, and(
      eq(pipelines.companyId, companyId),
      eq(pipelines.id, pipelineCases.pipelineId),
    ))
    .innerJoin(routines, and(
      eq(routines.companyId, companyId),
      eq(routines.id, pipelineAutomationExecutions.routineId),
    ))
    .where(and(
      eq(pipelineAutomationExecutions.companyId, companyId),
      eq(pipelineAutomationExecutions.id, caseRow.automationAttemptId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, row.sourcePipeline.id));
  const stage = stages.find((candidate) => stageAutomationId(candidate) === row.execution.automationId) ?? null;

  return {
    execution: {
      id: row.execution.id,
      automationId: row.execution.automationId,
      status: row.execution.status,
    },
    routine: {
      id: row.routine.id,
      title: row.routine.title,
    },
    pipeline: {
      id: row.sourcePipeline.id,
      key: row.sourcePipeline.key,
      name: row.sourcePipeline.name,
    },
    stage: stage
      ? {
        id: stage.id,
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
      }
      : null,
    case: {
      id: row.sourceCase.id,
      caseKey: row.sourceCase.caseKey,
      title: row.sourceCase.title,
      pipelineId: row.sourceCase.pipelineId,
    },
  };
}

function isLiveIssueStatus(status: string) {
  return status === "todo" || status === "in_progress" || status === "in_review";
}

function isWaitingIssueStatus(status: string) {
  return status === "backlog" || status === "todo" || status === "in_review";
}

function summarizeLinkedIssue(issue: typeof issueRows.$inferSelect) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
  };
}

function readBreakdownRequestKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const keys = (payload as Record<string, unknown>).requestKeys;
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((key): key is string => typeof key === "string" && key.trim().length > 0))];
}

function readStageBreakdownConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>).breakdown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function stageHasChildrenTerminalGate(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const record = config as Record<string, unknown>;
  return record.requireChildrenTerminal === true ||
    (typeof record.autoAdvanceOnChildrenTerminal === "string" && record.autoAdvanceOnChildrenTerminal.trim().length > 0);
}

function readStageAutomationId(stage: typeof pipelineStages.$inferSelect) {
  if (!stage.config || typeof stage.config !== "object" || Array.isArray(stage.config)) return null;
  const onEnterValue = (stage.config as Record<string, unknown>).onEnter;
  if (!onEnterValue || typeof onEnterValue !== "object" || Array.isArray(onEnterValue)) return null;
  const onEnter = onEnterValue as Record<string, unknown>;
  const rawId = typeof onEnter.id === "string" ? onEnter.id.trim() : "";
  const routineId = typeof onEnter.routineId === "string" ? onEnter.routineId.trim() : "";
  if (onEnter.type !== "run_routine" || routineId.length === 0) return null;
  return rawId.length > 0 ? rawId : `${stage.id}:on_enter`;
}

function readStageAutomationTargetPipelineId(stage: typeof pipelineStages.$inferSelect) {
  if (!readStageAutomationId(stage)) return null;
  const breakdown = readStageBreakdownConfig(stage.config);
  const targetPipelineId = typeof breakdown?.targetPipelineId === "string" ? breakdown.targetPipelineId.trim() : "";
  return targetPipelineId.length > 0 ? targetPipelineId : null;
}

async function assertStageAutomationTargetWriteAccess(
  db: Db,
  req: Request,
  input: {
    access: ReturnType<typeof accessService>;
    companyId: string;
    stage: { id: string };
  },
) {
  const stage = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.id, input.stage.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!stage) throw notFound("Pipeline stage not found");
  const targetPipelineId = readStageAutomationTargetPipelineId(stage);
  if (!targetPipelineId) return;
  await assertPipelineWriteAccess(req, {
    access: input.access,
    companyId: input.companyId,
    pipelineId: targetPipelineId,
  });
}

async function assertCurrentStageAutomationTargetWriteAccess(
  db: Db,
  req: Request,
  input: {
    access: ReturnType<typeof accessService>;
    companyId: string;
    caseId: string;
    automationId?: string;
  },
) {
  const row = await db
    .select({ stage: pipelineStages })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.id, input.caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");

  const currentAutomationId = readStageAutomationId(row.stage);
  if (input.automationId && currentAutomationId !== input.automationId) return;

  const targetPipelineId = readStageAutomationTargetPipelineId(row.stage);
  if (!targetPipelineId) return;

  await assertPipelineWriteAccess(req, {
    access: input.access,
    companyId: input.companyId,
    pipelineId: targetPipelineId,
  });
}

function parsePermissionPreflightFingerprint(fingerprint: string | null) {
  if (!fingerprint) return null;
  const parts = fingerprint.split(":");
  if (parts.length < 7) return null;
  const caseId = parts[0];
  const stageId = parts[1];
  const targetPipelineId = parts[parts.length - 4];
  const principalId = parts[parts.length - 3];
  const permissionKey = parts.slice(parts.length - 2).join(":");
  const automationId = parts.slice(2, parts.length - 4).join(":");
  if (!caseId || !stageId || !automationId || !targetPipelineId || !principalId || !permissionKey) return null;
  return { caseId, stageId, automationId, targetPipelineId, principalId, permissionKey };
}

async function latestBreakdownCreatedEvent(db: Db, companyId: string, caseId: string) {
  return db
    .select()
    .from(pipelineCaseEvents)
    .where(and(
      eq(pipelineCaseEvents.companyId, companyId),
      eq(pipelineCaseEvents.caseId, caseId),
      eq(pipelineCaseEvents.type, "updated"),
      sql`${pipelineCaseEvents.payload}->>'kind' = 'breakdown_created'`,
    ))
    .orderBy(desc(pipelineCaseEvents.createdAt), desc(pipelineCaseEvents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function derivePipelineCaseLiveness(
  db: Db,
  companyId: string,
  row: { case: typeof pipelineCases.$inferSelect; stage: typeof pipelineStages.$inferSelect },
): Promise<PipelineCaseLiveness> {
  if (row.case.terminalKind) {
    return {
      state: "terminal",
      reason: "terminal",
      message: `Pipeline item is terminal (${row.case.terminalKind}).`,
    };
  }

  if (row.case.leaseToken && row.case.leaseExpiresAt && row.case.leaseExpiresAt.getTime() > Date.now()) {
    return {
      state: "live",
      reason: "lease_active",
      message: "Pipeline item has an active lease.",
    };
  }

  const blockerCase = await db
    .select({
      id: pipelineCases.id,
      title: pipelineCases.title,
      terminalKind: pipelineCases.terminalKind,
    })
    .from(pipelineCaseBlockers)
    .innerJoin(pipelineCases, eq(pipelineCaseBlockers.blockedByCaseId, pipelineCases.id))
    .where(and(
      eq(pipelineCaseBlockers.companyId, companyId),
      eq(pipelineCaseBlockers.caseId, row.case.id),
      or(isNull(pipelineCases.terminalKind), ne(pipelineCases.terminalKind, "done")),
    ))
    .orderBy(asc(pipelineCases.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (blockerCase) {
    return {
      state: "blocked",
      reason: "case_blocked",
      message: `Pipeline item is blocked by "${blockerCase.title}".`,
      blocker: {
        caseId: blockerCase.id,
        title: blockerCase.title,
        terminalKind: blockerCase.terminalKind,
      },
    };
  }

  const linkedIssues = await db
    .select({ link: pipelineCaseIssueLinks, issue: issueRows })
    .from(pipelineCaseIssueLinks)
    .innerJoin(issueRows, eq(pipelineCaseIssueLinks.issueId, issueRows.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      eq(pipelineCaseIssueLinks.caseId, row.case.id),
      inArray(pipelineCaseIssueLinks.role, ["automation", "work"]),
      eq(issueRows.companyId, companyId),
      isNull(issueRows.hiddenAt),
    ))
    .orderBy(desc(issueRows.updatedAt), desc(pipelineCaseIssueLinks.createdAt));
  const blockedIssue = linkedIssues.find(({ issue }) => issue.status === "blocked");
  if (blockedIssue) {
    const blocker = await db
      .select({
        id: issueRows.id,
        identifier: issueRows.identifier,
        title: issueRows.title,
        status: issueRows.status,
      })
      .from(issueRelations)
      .innerJoin(issueRows, eq(issueRelations.issueId, issueRows.id))
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, blockedIssue.issue.id),
      ))
      .orderBy(asc(issueRows.title))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return {
      state: "blocked",
      reason: "linked_issue_blocked",
      message: `Linked ${blockedIssue.link.role} task is blocked.`,
      issue: summarizeLinkedIssue(blockedIssue.issue),
      blocker: blocker
        ? { issueId: blocker.id, title: blocker.title, status: blocker.status }
        : null,
    };
  }
  const activeIssue = linkedIssues.find(({ issue }) => issue.status === "in_progress");
  if (activeIssue) {
    return {
      state: "live",
      reason: "linked_issue_active",
      message: `Linked ${activeIssue.link.role} task is in progress.`,
      issue: summarizeLinkedIssue(activeIssue.issue),
    };
  }
  const waitingIssue = linkedIssues.find(({ issue }) => isWaitingIssueStatus(issue.status));
  if (waitingIssue) {
    return {
      state: isLiveIssueStatus(waitingIssue.issue.status) ? "waiting" : "attention",
      reason: "linked_issue_waiting",
      message: `Linked ${waitingIssue.link.role} task is ${waitingIssue.issue.status}.`,
      issue: summarizeLinkedIssue(waitingIssue.issue),
    };
  }

  const latestAutomation = await db
    .select()
    .from(pipelineAutomationExecutions)
    .where(and(
      eq(pipelineAutomationExecutions.companyId, companyId),
      eq(pipelineAutomationExecutions.caseId, row.case.id),
    ))
    .orderBy(desc(pipelineAutomationExecutions.updatedAt), desc(pipelineAutomationExecutions.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (latestAutomation?.status === "failed") {
    const fingerprint = latestAutomation.error?.startsWith("permission_preflight_failed:")
      ? latestAutomation.error.slice("permission_preflight_failed:".length)
      : null;
    const parsedFingerprint = parsePermissionPreflightFingerprint(fingerprint);
    if (parsedFingerprint?.permissionKey === "pipelines:write") {
      const decision = await authorizationService(db).decide({
        actor: {
          type: "agent",
          agentId: parsedFingerprint.principalId,
          companyId,
          source: "agent_key",
        },
        action: "pipelines:write",
        resource: { type: "company", companyId },
        scope: { pipelineId: parsedFingerprint.targetPipelineId },
      });
      if (decision.allowed) {
        return {
          state: "attention",
          reason: "automation_failed",
          message: "Pipeline automation permission has been restored; retry the failed automation ledger.",
          automation: {
            automationId: latestAutomation.automationId,
            routineId: latestAutomation.routineId,
            executionId: latestAutomation.id,
            error: latestAutomation.error,
            fingerprint,
          },
        };
      }
    }
    return {
      state: fingerprint ? "blocked" : "attention",
      reason: fingerprint ? "permission_preflight_failed" : "automation_failed",
      message: fingerprint
        ? "Pipeline automation is blocked until the configured assignee can write to the target pipeline."
        : "Pipeline automation failed and needs retry or recovery.",
      automation: {
        automationId: latestAutomation.automationId,
        routineId: latestAutomation.routineId,
        executionId: latestAutomation.id,
        error: latestAutomation.error,
        fingerprint,
      },
    };
  }

  const breakdownConfig = readStageBreakdownConfig(row.stage.config);
  if (breakdownConfig) {
    const breakdownEvent = await latestBreakdownCreatedEvent(db, companyId, row.case.id);
    if (!breakdownEvent) {
      return {
        state: "attention",
        reason: "breakdown_pending",
        message: "Breakdown stage has not recorded breakdown_created evidence yet.",
      };
    }
    const expectedRequestKeys = readBreakdownRequestKeys(breakdownEvent.payload);
    const createdRows = expectedRequestKeys.length > 0
      ? await db
        .select({ requestKey: pipelineCases.requestKey })
        .from(pipelineCases)
        .where(and(
          eq(pipelineCases.companyId, companyId),
          eq(pipelineCases.parentCaseId, row.case.id),
          inArray(pipelineCases.requestKey, expectedRequestKeys),
          isNull(pipelineCases.hiddenFromBoardAt),
        ))
      : [];
    const createdRequestKeys = [...new Set(createdRows
      .map((child) => child.requestKey)
      .filter((key): key is string => typeof key === "string"))];
    const missingRequestKeys = expectedRequestKeys.filter((key) => !createdRequestKeys.includes(key));
    if (missingRequestKeys.length > 0) {
      return {
        state: "blocked",
        reason: "breakdown_incomplete",
        message: "Breakdown evidence does not match created child cases.",
        breakdown: { expectedRequestKeys, createdRequestKeys, missingRequestKeys },
      };
    }
    const waitForPieces = breakdownConfig.waitForPieces === true;
    if (waitForPieces && row.case.childCount !== row.case.terminalChildCount) {
      return {
        state: "waiting",
        reason: "children_waiting",
        message: "Pipeline item is waiting for child items to finish.",
        breakdown: { expectedRequestKeys, createdRequestKeys, missingRequestKeys: [] },
      };
    }
  }

  if (stageHasChildrenTerminalGate(row.stage.config) && row.case.childCount !== row.case.terminalChildCount) {
    return {
      state: "waiting",
      reason: "children_waiting",
      message: "Pipeline item is waiting for child items to finish.",
    };
  }

  if (row.stage.kind === "review") {
    return {
      state: "waiting",
      reason: "review_waiting",
      message: "Pipeline item is waiting for stage review.",
    };
  }

  return {
    state: "attention",
    reason: "no_action_path",
    message: "No lease, linked work, blocker, automation retry, review, or breakdown action path is visible.",
  };
}

function buildCaseContextMarkdown(
  detail: Awaited<ReturnType<typeof getCaseDetail>>,
  bodyDocumentContext?: Awaited<ReturnType<typeof loadPipelineConversationBodyDocumentContext>> | null,
  outputSummaries?: ReturnType<typeof summarizePipelineCaseOutputsForContext> | null,
) {
  const bodyDocumentMarkdown = formatPipelineConversationBodyDocumentContextMarkdown(bodyDocumentContext ?? null);
  const outputMarkdown = formatPipelineCaseOutputContextMarkdown(outputSummaries ?? null);
  return [
    "## Pipeline Case Context",
    "",
    "## Conversation Instructions",
    "",
    "This task is the conversation thread for the linked pipeline item.",
    "Treat user comments in this thread as feedback on that pipeline item unless the user explicitly says otherwise.",
    "Iterate the pipeline item body document unless the user explicitly asks for item metadata, stage changes, or follow-up work.",
    "Inspect connected documents and outputs when present; if feedback affects a connected document, revise it too so the item and supporting documents stay in sync.",
    "Editing this discussion task itself is not the primary deliverable unless the user specifically requests it.",
    "",
    bodyDocumentMarkdown,
    bodyDocumentMarkdown ? "" : null,
    outputMarkdown,
    outputMarkdown ? "" : null,
    "## Pipeline Item Context",
    "",
    `Item: ${detail.case.title}`,
    `Pipeline: ${detail.pipeline.name} (${detail.pipeline.key})`,
    `Stage: ${detail.stage.name} (${detail.stage.key}, ${detail.stage.kind})`,
    `Item link: /PAP/pipelines/${detail.pipeline.id}/items/${detail.case.id}`,
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
  ].filter((line) => line !== null).join("\n");
}

async function getChildOutcomeSummaries(db: Db, companyId: string, caseId: string) {
  const children = await db
    .select({ case: pipelineCases, stage: pipelineStages, pipeline: pipelines })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.parentCaseId, caseId)))
    .orderBy(asc(pipelineCases.createdAt));
  if (children.length === 0) return [];

  const childIds = children.map((row) => row.case.id);
  const reviewEvents = await db
    .select()
    .from(pipelineCaseEvents)
    .where(and(
      eq(pipelineCaseEvents.companyId, companyId),
      inArray(pipelineCaseEvents.caseId, childIds),
      eq(pipelineCaseEvents.type, "review_decided"),
    ))
    .orderBy(desc(pipelineCaseEvents.createdAt), desc(pipelineCaseEvents.id));
  const latestReviewByCaseId = new Map<string, typeof pipelineCaseEvents.$inferSelect>();
  for (const event of reviewEvents) {
    if (!latestReviewByCaseId.has(event.caseId)) latestReviewByCaseId.set(event.caseId, event);
  }

  return children.map((row) => {
    const review = latestReviewByCaseId.get(row.case.id);
    const reviewPayload = review?.payload && typeof review.payload === "object" && !Array.isArray(review.payload)
      ? review.payload as Record<string, unknown>
      : {};
    const decision = typeof reviewPayload.decision === "string" ? reviewPayload.decision : null;
    const reason = typeof reviewPayload.reason === "string" ? reviewPayload.reason : null;
    return {
      id: row.case.id,
      caseKey: row.case.caseKey,
      title: row.case.title,
      href: `/pipelines/${row.pipeline.id}/items/${row.case.id}`,
      pipeline: { id: row.pipeline.id, key: row.pipeline.key, name: row.pipeline.name },
      stage: { id: row.stage.id, key: row.stage.key, name: row.stage.name, kind: row.stage.kind },
      status: row.case.terminalKind ? "terminal" : "open",
      terminalKind: row.case.terminalKind,
      approved: decision === "approve" ? true : row.case.terminalKind === "done" ? true : null,
      rejected: decision === "reject" ? true : row.case.terminalKind === "cancelled" ? true : null,
      reason,
    };
  });
}
