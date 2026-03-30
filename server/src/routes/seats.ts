import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { seatService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const attachHumanSchema = z.object({
  userId: z.string().min(1),
});

const detachHumanSchema = z.object({
  userId: z.string().min(1).optional().nullable(),
});

const updateSeatSchema = z.object({
  delegatedPermissions: z.array(z.enum(PERMISSION_KEYS)).default([]),
});

export function seatRoutes(db: Db) {
  const router = Router();
  const seatsSvc = seatService(db);

  router.get("/companies/:companyId/seats/:seatId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.getDetail(companyId, seatId);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    res.json(result);
  });

  router.patch("/companies/:companyId/seats/:seatId", validate(updateSeatSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.updateDelegatedPermissions(companyId, seatId, req.body.delegatedPermissions);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    res.json(result);
  });

  router.post("/companies/:companyId/seats/backfill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.backfillCompany(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/seats/reconcile-modes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.reconcileModes(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/attach-human", validate(attachHumanSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.attachHuman(companyId, seatId, req.body.userId);
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/detach-human", validate(detachHumanSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.detachHuman(companyId, seatId, req.body.userId ?? null);
    res.json(result);
  });

  return router;
}
