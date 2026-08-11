import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { enrichmentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";

export { FLAG_THRESHOLD } from "../services/enrichment.js";

const rejectStagingRowSchema = z.object({
  reason: z.string().max(1_000).optional(),
});

function parseBatchIdQuery(query: Record<string, unknown>): string {
  const raw = Array.isArray(query.batchId) ? query.batchId[0] : query.batchId;
  if (raw == null || raw === "") throw badRequest("batchId is required");
  return String(raw);
}

function parseFlaggedQuery(query: Record<string, unknown>): boolean {
  const raw = Array.isArray(query.flagged) ? query.flagged[0] : query.flagged;
  return raw === "true" || raw === "1";
}

export function enrichmentRoutes(db: Db) {
  const router = Router();
  const enrichment = enrichmentService(db);

  router.get("/companies/:companyId/enrichment/batches", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const batches = await enrichment.listBatches(companyId);
    res.json({ batches });
  });

  router.get("/companies/:companyId/enrichment/staging", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const batchId = parseBatchIdQuery(req.query);
    const flaggedOnly = parseFlaggedQuery(req.query);
    const rows = await enrichment.listStagingRows(companyId, batchId, { flaggedOnly });
    res.json({ rows });
  });

  router.post("/companies/:companyId/enrichment/staging/:id/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const row = await enrichment.approveRow(companyId, id, actor.actorId);
    if (!row) {
      // Missing, cross-company, or already reviewed — never mutated, so report a
      // non-success unchanged outcome rather than leaking existence.
      res.status(404).json({ error: "Row not found or already reviewed" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "enrichment.row_approved",
      entityType: "enrichment_staging",
      entityId: row.id,
      details: { batchId: row.batchId, verdict: "approved" },
    });

    res.json({ ok: true });
  });

  router.post(
    "/companies/:companyId/enrichment/staging/:id/reject",
    validate(rejectStagingRowSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const row = await enrichment.rejectRow(companyId, id, actor.actorId, req.body.reason);
      if (!row) {
        res.status(404).json({ error: "Row not found or already reviewed" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "enrichment.row_rejected",
        entityType: "enrichment_staging",
        entityId: row.id,
        details: { batchId: row.batchId, verdict: row.reviewerVerdict },
      });

      res.json({ ok: true });
    },
  );

  router.post("/companies/:companyId/enrichment/batches/:batchId/bulk-approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const batchId = req.params.batchId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const approvedCount = await enrichment.bulkApproveBatch(companyId, batchId, actor.actorId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "enrichment.batch_bulk_approved",
      entityType: "enrichment_batch",
      entityId: batchId,
      details: { batchId, approvedCount },
    });

    res.json({ ok: true, approved_count: approvedCount });
  });

  return router;
}
