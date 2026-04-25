import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@paperclipai/db";
import { truthPromotionRequests } from "@paperclipai/db";
import {
  approveTruthPromotionRequestSchema,
  completeTruthPromotionRequestSchema,
  createTruthAtomSchema,
  createTruthBriefSchema,
  createTruthDocumentChunkSchema,
  createTruthDocumentSchema,
  createTruthDossierSchema,
  createTruthPromotionRequestSchema,
  createTruthRunAuditSchema,
  createTruthRunSchema,
  failTruthPromotionRequestSchema,
  rejectTruthPromotionRequestSchema,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity, truthRuntimeService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type TruthPromotionRequestRow = typeof truthPromotionRequests.$inferSelect;

const ignoredDossierHash = "0".repeat(64);

function parseTruthInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid truth runtime input", parsed.error.flatten());
  }
  return parsed.data;
}

function parseDossierInput(input: unknown) {
  const rawInput = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return parseTruthInput(createTruthDossierSchema, {
    ...rawInput,
    briefInputHash: Object.prototype.hasOwnProperty.call(rawInput, "briefInputHash")
      ? rawInput.briefInputHash
      : ignoredDossierHash,
    briefPayloadHash: Object.prototype.hasOwnProperty.call(rawInput, "briefPayloadHash")
      ? rawInput.briefPayloadHash
      : ignoredDossierHash,
  });
}

function promotionCanExpire(request: TruthPromotionRequestRow) {
  return request.status === "pending" || request.status === "approved";
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
      await logTruthActivity(req, {
        companyId: expired.companyId,
        action: "truth.promotion_expired",
        entityType: "truth_promotion_request",
        entityId: expired.id,
        details: {
          truthRunId: expired.truthRunId,
          briefId: expired.briefId,
          dossierId: expired.dossierId,
        },
      });
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
    const input = parseDossierInput(req.body);
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
      details: {
        truthRunId: promotion.truthRunId,
        briefId: promotion.briefId,
        dossierId: promotion.dossierId,
      },
    });
    res.status(201).json(promotion);
  });

  router.post("/truth/promotions/:id/approve", async (req, res) => {
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    const input = parseTruthInput(approveTruthPromotionRequestSchema, req.body);
    const promotion = await svc.approvePromotionRequest(request.companyId, id, input.approvedBy);
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_approved",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: { approvedBy: promotion.approvedBy },
    });
    res.json(promotion);
  });

  router.post("/truth/promotions/:id/reject", async (req, res) => {
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    const input = parseTruthInput(rejectTruthPromotionRequestSchema, req.body);
    const promotion = await svc.rejectPromotionRequest(request.companyId, id, input.rejectionReason);
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_rejected",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: { rejectionReason: promotion.rejectionReason },
    });
    res.json(promotion);
  });

  router.post("/truth/promotions/:id/complete", async (req, res) => {
    const id = req.params.id as string;
    const request = await loadPromotionRequestForLifecycle(req, id);
    parseTruthInput(completeTruthPromotionRequestSchema, req.body);
    const promotion = await svc.completePromotionRequest(request.companyId, id);
    await logTruthActivity(req, {
      companyId: promotion.companyId,
      action: "truth.promotion_completed",
      entityType: "truth_promotion_request",
      entityId: promotion.id,
      details: {
        truthRunId: promotion.truthRunId,
        briefId: promotion.briefId,
        dossierId: promotion.dossierId,
      },
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
      details: { failureReason: promotion.failureReason },
    });
    res.json(promotion);
  });

  return router;
}
