import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { CreateCpsIdeaInput, CreateCpsJudgmentFeedbackInput, CreateCpsRunRequestInput } from "@paperclipai/shared";
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

  // E3 idea intake: paste an X post / article / paper. Snapshot happens at
  // intake; decomposition runs in the bounded CPS consumer, never inline here.
  router.post("/companies/:companyId/cps-experiments/ideas", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    try {
      const idea = await svc.createIdeaIntake(companyId, req.body as CreateCpsIdeaInput);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "cps.idea_intake.created",
        entityType: "cps_idea_intake",
        entityId: idea.id,
        details: {
          sourceType: idea.sourceType,
          url: idea.url,
          snapshotFetchStatus: idea.snapshot.fetchStatus,
          runRequestId: idea.runRequestId,
        },
      });
      res.status(201).json(idea);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid idea intake" });
    }
  });

  router.post("/companies/:companyId/cps-experiments/judgment-feedback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    try {
      const feedback = await svc.createJudgmentFeedback(companyId, req.body as CreateCpsJudgmentFeedbackInput);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "cps.judgment_label.created",
        entityType: "cps_judgment_feedback",
        entityId: feedback.id,
        details: {
          experimentId: feedback.experimentId,
          label: feedback.label,
          correctedVerdict: feedback.correctedVerdict,
          routeToRole: feedback.routeToRole,
          judgmentPath: feedback.judgmentPath,
        },
      });
      res.status(201).json(feedback);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid CPS judgment feedback" });
    }
  });

  return router;
}
