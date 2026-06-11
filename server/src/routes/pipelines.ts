import { Router, type Request } from "express";
import { z } from "zod";
import { and, asc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
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
import { assertCompanyAccess } from "./authz.js";

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
});

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

export function pipelineRoutes(db: Db, options: Parameters<typeof pipelineService>[1] = {}) {
  const router = Router();
  const svc = pipelineService(db, options);

  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertPipelineCompanyAccess(req, companyId);
    const rows = await db
      .select({
        pipeline: pipelines,
        stageCount: sql<number>`count(distinct ${pipelineStages.id})::int`,
        openCaseCount: sql<number>`count(distinct ${pipelineCases.id}) filter (where ${pipelineCases.terminalKind} is null)::int`,
      })
      .from(pipelines)
      .leftJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
      .leftJoin(pipelineCases, eq(pipelineCases.pipelineId, pipelines.id))
      .where(eq(pipelines.companyId, companyId))
      .groupBy(pipelines.id)
      .orderBy(asc(pipelines.createdAt));
    res.json(rows.map((row) => ({ ...row.pipeline, stageCount: row.stageCount, openCaseCount: row.openCaseCount })));
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
    res.json({ ...pipeline, stages, transitions, documentKeys });
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
    actorForMutation(req);
    try {
      const stage = await svc.createStage({
        companyId,
        pipelineId,
        key: req.body.key,
        name: req.body.name,
        kind: req.body.kind,
        position: req.body.position,
        config: req.body.config,
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
    actorForMutation(req);
    try {
      res.json(await svc.updateStage({ companyId, pipelineId, stageId, patch: req.body }));
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
    const row = await db
      .select({ link: pipelineDocuments, document: documents, revision: documentRevisions })
      .from(pipelineDocuments)
      .innerJoin(documents, eq(pipelineDocuments.documentId, documents.id))
      .leftJoin(documentRevisions, eq(documents.latestRevisionId, documentRevisions.id))
      .where(and(eq(pipelineDocuments.companyId, companyId), eq(pipelineDocuments.pipelineId, pipelineId), eq(pipelineDocuments.key, key)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Pipeline document not found");
    res.json(row);
  });

  router.put("/pipelines/:pipelineId/documents/:key", validate(upsertPipelineDocumentSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const companyId = await assertPipelineAccess(db, req, pipelineId);
    const actor = actorForMutation(req);
    const result = await db.transaction(async (tx) => {
      const existing = await tx.select().from(pipelineDocuments)
        .where(and(eq(pipelineDocuments.companyId, companyId), eq(pipelineDocuments.pipelineId, pipelineId), eq(pipelineDocuments.key, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const [document] = existing
        ? await tx.update(documents).set({ title: req.body.title ?? key, updatedAt: new Date() }).where(eq(documents.id, existing.documentId)).returning()
        : await tx.insert(documents).values({
          companyId,
          title: req.body.title ?? key,
          latestBody: req.body.body,
          latestRevisionNumber: 1,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "user" ? actor.userId : null,
        }).returning();
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(documentRevisions)
        .where(eq(documentRevisions.documentId, document!.id));
      const [revision] = await tx.insert(documentRevisions).values({
        companyId,
        documentId: document!.id,
        revisionNumber: (count ?? 0) + 1,
        title: req.body.title ?? document!.title,
        body: req.body.body,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
      }).returning();
      await tx.update(documents).set({
        latestBody: req.body.body,
        latestRevisionId: revision!.id,
        latestRevisionNumber: revision!.revisionNumber,
        updatedAt: new Date(),
        updatedByAgentId: actor.type === "agent" ? actor.agentId : null,
        updatedByUserId: actor.type === "user" ? actor.userId : null,
      }).where(eq(documents.id, document!.id));
      if (!existing) {
        await tx.insert(pipelineDocuments).values({ companyId, pipelineId, documentId: document!.id, key });
      }
      return { document: { ...document!, latestRevisionId: revision!.id }, revision };
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
    res.json(rows);
  });

  router.get("/cases/:caseId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const detail = await getCaseDetail(db, companyId, caseId);
    res.json(detail);
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
        title: `Discuss case: ${detail.case.title}`,
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
    const targetIssue = await db
      .select({ id: issueRows.id, companyId: issueRows.companyId })
      .from(issueRows)
      .where(eq(issueRows.id, req.body.issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!targetIssue || targetIssue.companyId !== companyId) throw notFound("Issue not found");
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
    if (!deleted) throw notFound("Pipeline case issue link not found");
    res.json({ deleted: true });
  });

  router.get("/cases/:caseId/events", async (req, res) => {
    const caseId = req.params.caseId as string;
    const companyId = await assertCaseAccess(db, req, caseId);
    const pagination = parseCaseEventsQuery(req.query);
    res.json(await svc.listCaseEventsPage(companyId, caseId, pagination));
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
  const [allowedNextStages, links, blockers, blocks, children] = await Promise.all([
    db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, row.case.pipelineId)).orderBy(asc(pipelineStages.position)),
    db.select().from(pipelineCaseIssueLinks).where(and(eq(pipelineCaseIssueLinks.companyId, companyId), eq(pipelineCaseIssueLinks.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.caseId, caseId))),
    db.select().from(pipelineCaseBlockers).where(and(eq(pipelineCaseBlockers.companyId, companyId), eq(pipelineCaseBlockers.blockedByCaseId, caseId))),
    db.select().from(pipelineCases).where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.parentCaseId, caseId))),
  ]);
  return {
    ...row,
    allowedNextStages,
    links,
    blockers,
    blocks,
    childrenSummary: {
      childCount: row.case.childCount,
      terminalChildCount: row.case.terminalChildCount,
      loadedChildren: children.length,
    },
    pendingSuggestion: row.case.pendingSuggestion,
  };
}

function buildCaseContextMarkdown(detail: Awaited<ReturnType<typeof getCaseDetail>>) {
  return [
    "## Pipeline Case Context",
    "",
    `Case: ${detail.case.title}`,
    `Pipeline: ${detail.pipeline.name} (${detail.pipeline.key})`,
    `Stage: ${detail.stage.name} (${detail.stage.key}, ${detail.stage.kind})`,
    `Case link: /PAP/pipelines/${detail.pipeline.id}/cases/${detail.case.id}`,
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
