import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, badRequest } from "../errors.js";
import { getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { mcpAllowlist } from "../middleware/mcp-allowlist.js";
import { getApplicationLogs, isDokployMcpConfigured } from "../services/dokploy-mcp-client.js";
import { logger } from "../middleware/logger.js";

/**
 * Infrastructure proxy routes.
 *
 * Exposes read-only Dokploy MCP tools behind standard Paperclip auth.
 * Agents call these endpoints — they never talk to Dokploy MCP directly.
 */
export function infrastructureRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/infrastructure/logs/:applicationId
   *
   * Returns container logs for a Dokploy application.
   * Auth: any authenticated actor (board user or agent).
   * MCP tool: get-application-logs (validated by allowlist middleware).
   */
  router.get("/infrastructure/logs/:applicationId", mcpAllowlist("get-application-logs"), async (req, res) => {
    // Require authentication (board or agent)
    if (req.actor.type === "none") {
      throw forbidden("Authentication required");
    }

    const { applicationId } = req.params;
    if (!applicationId || typeof applicationId !== "string") {
      throw badRequest("applicationId is required");
    }

    if (!isDokployMcpConfigured()) {
      res.status(503).json({
        error: "Dokploy MCP is not configured on this instance",
      });
      return;
    }

    // Audit log the access
    const actor = getActorInfo(req);
    const companyId = req.actor.type === "agent" ? req.actor.companyId : req.actor.companyIds?.[0];

    logger.info(
      {
        applicationId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
      "Infrastructure log request",
    );

    if (companyId) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "infrastructure.logs.read",
        entityType: "dokploy_application",
        entityId: applicationId,
        details: { tool: "get-application-logs" },
      });
    }

    const result = await getApplicationLogs(applicationId);
    res.json(result);
  });

  return router;
}
