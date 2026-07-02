import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { issueService, logActivity } from "../services/index.js";
import { createSupervisorRun } from "../services/supervisor-runs.js";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

const createSupervisorRunSchema = z.object({
  issueId: z.string().uuid(),
  motif: z.string().max(500).optional(),
  source: z.string().max(100).optional(),
});

export function supervisorRunsRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);

  router.post("/supervisor-runs", validate(createSupervisorRunSchema), async (req, res, next) => {
    try {
      assertBoardOrAgent(req);

      const { issueId, motif, source } = req.body as z.infer<typeof createSupervisorRunSchema>;

      const issue = await svc.getById(issueId);
      if (!issue) throw notFound("Issue not found");

      assertCompanyAccess(req, issue.companyId);

      const actor = getActorInfo(req);
      const agentId = actor.actorType === "agent" && actor.agentId ? actor.agentId : null;
      if (!agentId) {
        res.status(403).json({ error: "Supervisor runs require agent authentication" });
        return;
      }

      const result = await createSupervisorRun(db, {
        companyId: issue.companyId,
        agentId,
        issueId,
        motif,
        source,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: result.runId,
        action: "supervisor_run.created",
        entityType: "issue",
        entityId: issueId,
        details: { source: source ?? null, motif: motif ?? null },
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
