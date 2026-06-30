import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentsStudioService } from "../services/index.js";

/**
 * Public, token-authed inbound channel. An external surface (Slack/Teams/web
 * widget/curl) POSTs a user message with the workflow's deploy token; the
 * workflow runs and an ack is returned. Mounted OUTSIDE the session-auth API
 * router — auth here is the bearer deploy token, nothing else.
 */
export function channelRoutes(db: Db, options: { pluginWorkerManager?: unknown } = {}) {
  const router = Router();
  const svc = agentsStudioService(db);

  router.post("/api/channels/:workflowId", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const auth = req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
    const message = typeof req.body?.message === "string" ? req.body.message : "";

    const result = await svc.runByToken(workflowId, token, {
      pluginWorkerManager: options.pluginWorkerManager,
      message,
    });
    if (!result) {
      res.status(401).json({ error: "Invalid workflow or token" });
      return;
    }
    res.json(result);
  });

  return router;
}
