import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSubAgentRunSchema,
  completeSubAgentRunSchema,
  rateSubAgentRunSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { subAgentRunsService } from "../services/sub-agent-runs.js";

export function subAgentRunRoutes(db: Db) {
  const router = Router();
  const svc = subAgentRunsService(db);

  // Create — leader reports sub-agent spawn
  router.post(
    "/companies/:companyId/sub-agent-runs",
    validate(createSubAgentRunSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const leaderAgentId = actor.agentId;
      if (!leaderAgentId) {
        res.status(403).json({ error: "Only agents can report sub-agent runs" });
        return;
      }
      const row = await svc.create(companyId, leaderAgentId, req.body);
      res.status(201).json(row);
    },
  );

  // Complete — leader reports sub-agent finished
  router.patch(
    "/sub-agent-runs/:id/complete",
    validate(completeSubAgentRunSchema),
    async (req, res) => {
      try {
        const row = await svc.complete(req.params.id as string, req.body);
        res.json(row);
      } catch (err: any) {
        res.status(err.status ?? 500).json({ error: err.message });
      }
    },
  );

  // Rate — board user evaluates result
  router.patch(
    "/sub-agent-runs/:id/rate",
    validate(rateSubAgentRunSchema),
    async (req, res) => {
      const actor = getActorInfo(req);
      const userId = actor.actorType === "user" ? actor.actorId : "unknown";
      try {
        const row = await svc.rate(req.params.id as string, req.body, userId);
        res.json(row);
      } catch (err: any) {
        res.status(err.status ?? 500).json({ error: err.message });
      }
    },
  );

  // List for company
  router.get("/companies/:companyId/sub-agent-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filter: { subAgentId?: string; leaderAgentId?: string } = {};
    if (req.query.subAgentId) filter.subAgentId = req.query.subAgentId as string;
    if (req.query.leaderAgentId) filter.leaderAgentId = req.query.leaderAgentId as string;
    const rows = await svc.list(companyId, filter);
    res.json(rows);
  });

  // List for specific agent (as sub-agent)
  router.get("/agents/:agentId/sub-agent-runs", async (req, res) => {
    const rows = await svc.listForAgent(req.params.agentId as string);
    res.json(rows);
  });

  // List delegations by leader
  router.get("/agents/:agentId/delegated-runs", async (req, res) => {
    const rows = await svc.listByLeader(req.params.agentId as string);
    res.json(rows);
  });

  return router;
}
