import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { truthPromotionRequests } from "@paperclipai/db";
import {
  completeTruthPromotionRequestSchema,
  createTruthAtomSchema,
  createTruthBriefSchema,
  createTruthDocumentChunkSchema,
  createTruthDocumentSchema,
  createTruthPromotionRequestSchema,
  createTruthRunAuditSchema,
  createTruthRunSchema,
  failTruthPromotionRequestSchema,
  rejectTruthPromotionRequestSchema,
  truthDossierStatusSchema,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity, truthRuntimeService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

type TruthPromotionRequestRow = typeof truthPromotionRequests.$inferSelect;

const requiredTextSchema = z.string().trim().min(1);
const sha256HexSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, "Must be a SHA-256 hex digest")
  .transform((value) => value.toLowerCase());
const metadataSchema = z.record(z.unknown());
const optionalGeneratedAtSchema = z.string().datetime().optional();
const hasText = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;

const createTruthDossierRouteSchema = z
  .object({
    truthRunId: z.string().uuid(),
    briefId: z.string().uuid(),
    title: requiredTextSchema,
    status: truthDossierStatusSchema.optional().default("draft"),
    htmlContent: z.string().optional().nullable(),
    filePath: z.string().optional().nullable(),
    contentSha256: sha256HexSchema.optional().nullable(),
    promptVersion: requiredTextSchema,
    templateVersion: requiredTextSchema,
    generatedAt: optionalGeneratedAtSchema,
    generatedByAgentId: z.string().uuid().optional().nullable(),
    generatedByUserId: z.string().optional().nullable(),
    metadata: metadataSchema.optional().default({}),
  })
  .superRefine((value, ctx) => {
    if (!hasText(value.htmlContent) && !hasText(value.filePath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either htmlContent or filePath is required",
        path: ["htmlContent"],
      });
    }
  });

function parseTruthInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid truth runtime input", parsed.error.flatten());
  }
  return parsed.data;
}

function promotionCanExpire(request: TruthPromotionRequestRow) {
  return request.status === "pending" || request.status === "approved";
}

function isPromotionExpiredError(error: unknown) {
  return error instanceof HttpError && error.status === 422 && error.message === "Promotion request expired";
}

export function truthRuntimeRoutes(db: Db) {
  const router = Router();
  const svc = truthRuntimeService(db);

  async function logTruthActivity(
    req: Request,
    input: {
      companyId: string;
      action: string;
      entityType: string;
      entityId: string;
      details?: Record<string, unknown> | null;
    },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: input.details ?? null,
    });
  }

  function getBoardApprovalActorId(req: Request) {
    assertBoard(req);
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  function promotionTargetDetails(promotion: {
    truthRunId: string | null;
    briefId: string | null;
    dossierId: string | null;
  }) {
    return {
      truthRunId: promotion.truthRunId,
      briefId: promotion.briefId,
      dossierId: promotion.dossierId,
    };
  }

  async function logPromotionExpired(req: Request, expired: TruthPromotionRequestRow) {
    await logTruthActivity(req, {
      companyId: expired.companyId,
      action: "truth.promotion_expired",
      entityType: "truth_promotion_request",
      entityId: expired.id,
      details: promotionTargetDetails(expired),
    });
  }

  async function logServiceExpiryAndRethrow(req: Request, request: TruthPromotionRequestRow, error: unknown): Promise<never> {
    if (isPromotionExpiredError(error)) {
      const expired = await svc.getPromotionRequest(request.companyId, request.id);
      if (expired.status === "expired") {
        await logPromotionExpired(req, expired);
      }
    }
    throw error;
  }

  async function loadPromotionRequestForLifecycle(req: Request, id: string) {
    const request = await db
      .select()
      .from(truthPromotionRequests)
      .where(eq(truthPromotionRequests.id, id))
      .then((rows) => rows[0] ?? null);
    if (!request) throw notFound("Promotion request not found");

    assertCompanyAccess(req, request.companyId);

    if (request.expiresAt && request.expiresAt.getTime() <= Date.now() && promotionCanExpire(request)) {
      const expired = await svc.expirePromotionRequest(request.companyId, request.id);
      await logPromotionExpired(req, expired);
      throw unprocessable("Promotion request expired", { status: expired.status });
    }

    return request;
  }

  router.get("/companies/:companyId/truth/documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listDocuments(companyId));
  });

  router.post("/companies/:companyId/truth/documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthDocumentSchema, req.body);
    const document = await svc.createDocument(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.document_created",
      entityType: "truth_document",
      entityId: document.id,
      details: { title: document.title, sourceType: document.sourceType },
    });
    res.status(201).json(document);
  });

  router.post("/companies/:companyId/truth/chunks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthDocumentChunkSchema, req.body);
    const chunk = await svc.createDocumentChunk(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.chunk_created",
      entityType: "truth_document_chunk",
      entityId: chunk.id,
      details: { truthDocumentId: chunk.truthDocumentId, deterministicKey: chunk.deterministicKey },
    });
    res.status(201).json(chunk);
  });

  router.post("/companies/:companyId/truth/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthRunSchema, req.body);
    const run = await svc.createRun(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.run_created",
      entityType: "truth_run",
      entityId: run.id,
      details: { truthDocumentId: run.truthDocumentId, status: run.status },
    });
    res.status(201).json(run);
  });

  router.post("/companies/:companyId/truth/atoms", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthAtomSchema, req.body);
    const atom = await svc.createAtom(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.atom_created",
      entityType: "truth_atom",
      entityId: atom.id,
      details: { truthRunId: atom.truthRunId, truthDocumentId: atom.truthDocumentId, status: atom.status },
    });
    res.status(201).json(atom);
  });

  router.post("/companies/:companyId/truth/audits", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthRunAuditSchema, req.body);
    const audit = await svc.createAudit(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.audit_created",
      entityType: "truth_run_audit",
      entityId: audit.id,
      details: { truthRunId: audit.truthRunId, auditType: audit.auditType, status: audit.status },
    });
    res.status(201).json(audit);
  });

  router.post("/companies/:companyId/truth/briefs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthBriefSchema, req.body);
    const brief = await svc.createBrief(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.brief_created",
      entityType: "truth_brief",
      entityId: brief.id,
      details: { truthRunId: brief.truthRunId, status: brief.status, briefKind: brief.briefKind },
    });
    res.status(201).json(brief);
  });

  router.post("/companies/:companyId/truth/dossiers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthDossierRouteSchema, req.body);
    const dossier = await svc.createDossier(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.dossier_created",
      entityType: "truth_dossier",
      entityId: dossier.id,
      details: { truthRunId: dossier.truthRunId, briefId: dossier.briefId, status: dossier.status },
    });
    res.status(201).json(dossier);
  });

  router.post("/companies/:companyId/truth/promotions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = parseTruthInput(createTruthPromotionRequestSchema, req.body);
    const promotion = await svc.createPromotionRequest(companyId, input);
    await logTruthActivity(req, {
      companyId,
      action: "truth.promotion_requested",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: promotionTargetDetails(promotion),
    });
    res.status(201).json(promotion);
  });

  router.post("/truth/promotions/:id/approve", async (req, res) => {
    const approvedBy = getBoardApprovalActorId(req);
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    parseTruthInput(completeTruthPromotionRequestSchema, req.body);
    const promotion = await svc.approvePromotionRequest(request.companyId, id, approvedBy).catch((error) =>
      logServiceExpiryAndRethrow(req, request, error)
    );
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_approved",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: { approvedBy: promotion.approvedBy, ...promotionTargetDetails(promotion) },
    });
    res.json(promotion);
  });

  router.post("/truth/promotions/:id/reject", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    const input = parseTruthInput(rejectTruthPromotionRequestSchema, req.body);
    const promotion = await svc.rejectPromotionRequest(request.companyId, id, input.rejectionReason);
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_rejected",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: { rejectionReason: promotion.rejectionReason, ...promotionTargetDetails(promotion) },
    });
    res.json(promotion);
  });

  router.post("/truth/promotions/:id/complete", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    parseTruthInput(completeTruthPromotionRequestSchema, req.body);
    const promotion = await svc.completePromotionRequest(request.companyId, id).catch((error) =>
      logServiceExpiryAndRethrow(req, request, error)
    );
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_completed",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: promotionTargetDetails(promotion),
    });
    res.json(promotion);
  });

  router.post("/truth/promotions/:id/fail", async (req, res) => {
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    const input = parseTruthInput(failTruthPromotionRequestSchema, req.body);
    const promotion = await svc.failPromotionRequest(request.companyId, id, input.failureReason);
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_failed",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: { failureReason: promotion.failureReason, ...promotionTargetDetails(promotion) },
    });
    res.json(promotion);
  });

  return router;
}
