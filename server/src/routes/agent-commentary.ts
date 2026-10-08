import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { submitAgentCommentary } from "../services/agent-commentary.js";
import { assertCompanyAccess } from "./authz.js";

export function agentCommentaryRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/agent-commentary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) {
      throw forbidden("Feedback requires an authenticated agent run");
    }
    const result = await submitAgentCommentary(db, {
      companyId, agentId: req.actor.agentId, runId: req.actor.runId, agentApiKeyId: req.actor.keyId,
    }, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
