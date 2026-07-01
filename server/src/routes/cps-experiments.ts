import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { CreateCpsRunRequestInput } from "@paperclipai/shared";
import { cpsExperimentsService } from "../services/cps-experiments.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// CPS experiment board surface. Reads the local tracker and lets board users
// queue bounded CPS research requests. It never invokes a shell or broker inline.
export function cpsExperimentRoutes(db: Db) {
  const router = Router();
  const svc = cpsExperimentsService();

  router.get("/companies/:companyId/cps-experiments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  router.post("/companies/:companyId/cps-experiments/run-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    try {
      const request = await svc.createRunRequest(companyId, req.body as CreateCpsRunRequestInput);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "cps.run_request.queued",
        entityType: "cps_run_request",
        entityId: request.id,
        details: {
          action: request.action,
          experimentId: request.experimentId,
          allowPaidData: request.safety.allowPaidData,
          allowPaidCompute: request.safety.allowPaidCompute,
        },
      });
      res.status(202).json(request);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid CPS run request" });
    }
  });

  return router;
}
