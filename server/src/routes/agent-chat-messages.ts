import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { sendAgentChatMessage } from "../services/agent-chat-messages.js";
import { assertCompanyAccess } from "./authz.js";

export function agentChatMessageRoutes(db: Db) {
  const router = Router();
  router.post("/agents/me/chat/messages", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
      throw forbidden("An authenticated task run is required");
    }
    assertCompanyAccess(req, req.actor.companyId);
    const receipt = await sendAgentChatMessage(db, {
      companyId: req.actor.companyId, agentId: req.actor.agentId, runId: req.actor.runId, agentApiKeyId: req.actor.keyId,
      keyScope: req.actor.keyScope, onBehalfOfUserId: req.actor.onBehalfOfUserId,
      authorizingUserId: req.actor.authorizingUserId, source: req.actor.source,
    }, req.body);
    res.status(receipt!.replayed ? 200 : 201).json(receipt);
  });
  return router;
}
