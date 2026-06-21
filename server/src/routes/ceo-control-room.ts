import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { ceoControlRoomService } from "../services/ceo-control-room.js";
import { assertCompanyAccess } from "./authz.js";

export function ceoControlRoomRoutes(db: Db) {
  const router = Router();
  const svc = ceoControlRoomService(db);

  const operationalIncidentSchema = z.object({
    routineId: z.string().uuid().optional().nullable(),
    routineTitle: z.string().trim().min(1),
    note: z.string().trim().max(2_000).optional().nullable(),
  });

  const pauseRoutineSchema = z.object({
    note: z.string().trim().max(2_000).optional().nullable(),
  });

  const resolveIncidentSchema = z.object({
    issueId: z.string().uuid(),
    routineId: z.string().uuid().optional().nullable(),
    reenableRoutine: z.boolean().optional(),
    note: z.string().trim().max(2_000).optional().nullable(),
  });

  router.get("/companies/:companyId/ceo-control-room", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = await svc.status(companyId);
    res.json(status);
  });

  router.post("/companies/:companyId/ceo-control-room/operational-loops/incident", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = operationalIncidentSchema.parse(req.body ?? {});
    const result = await svc.createOrUpdateOperationalIncident(companyId, input);
    res.json(result);
  });

  router.post("/companies/:companyId/ceo-control-room/routines/:routineId/pause", async (req, res) => {
    const companyId = req.params.companyId as string;
    const routineId = req.params.routineId as string;
    assertCompanyAccess(req, companyId);
    const input = pauseRoutineSchema.parse(req.body ?? {});
    const result = await svc.pauseRoutine(companyId, routineId, input.note);
    res.json(result);
  });

  router.post("/companies/:companyId/ceo-control-room/operational-loops/resolve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = resolveIncidentSchema.parse(req.body ?? {});
    const result = await svc.resolveOperationalIncident(companyId, input);
    res.json(result);
  });

  return router;
}
