import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const TOOL_GATEWAY_ACTIONS = [
  "tool_gateway.session_created",
  "tool_gateway.session_rejected",
  "tool_gateway.discovery",
  "tool_gateway.call_allowed",
  "tool_gateway.call_denied",
  "tool_gateway.call_completed",
  "tool_gateway.call_failed",
  "tool_gateway.call_deferred",
  "tool_gateway.approval_requested",
];

function gatewayToken(req: { header(name: string): string | undefined }) {
  return req.header("x-paperclip-tool-gateway-token")?.trim() || null;
}

function sendGatewayError(res: import("express").Response, err: unknown) {
  if (err instanceof ToolGatewayHttpError) {
    res.status(err.status).json({
      error: err.message,
      reasonCode: err.reasonCode,
      ...err.details,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

export function toolGatewayRoutes(db: Db, toolGateway: ToolGatewayService) {
  const router = Router();

  router.post("/tool-gateway/sessions", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const actor = getActorInfo(req);
      const body = (req.body ?? {}) as {
        companyId?: string;
        agentId?: string;
        runId?: string;
        issueId?: string | null;
        projectId?: string | null;
        ttlMs?: number;
      };

      const companyId = req.actor.type === "agent" ? req.actor.companyId : body.companyId;
      const agentId = req.actor.type === "agent" ? req.actor.agentId : body.agentId;
      const runId = req.actor.type === "agent" ? (req.actor.runId ?? body.runId) : body.runId;
      if (!companyId || !agentId || !runId) {
        res.status(400).json({ error: "companyId, agentId, and runId are required" });
        return;
      }
      assertCompanyAccess(req, companyId);

      const session = await toolGateway.createSession({
        companyId,
        agentId,
        runId,
        issueId: body.issueId ?? null,
        projectId: body.projectId ?? null,
        ttlMs: body.ttlMs,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });

      res.status(201).json({
        sessionId: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        toolsUrl: "/api/tool-gateway/tools",
        callUrl: "/api/tool-gateway/tools/call",
      });
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.get("/tool-gateway/tools", async (req, res) => {
    try {
      const token = gatewayToken(req);
      if (!token) {
        res.status(401).json({ error: "Tool gateway session token is required" });
        return;
      }
      const tools = await toolGateway.listToolsForSession(token);
      res.json(tools);
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/tools/call", async (req, res) => {
    try {
      const token = gatewayToken(req);
      if (!token) {
        res.status(401).json({ error: "Tool gateway session token is required" });
        return;
      }
      const body = (req.body ?? {}) as {
        tool?: unknown;
        parameters?: unknown;
        timeoutMs?: number;
        approvedActionRequestId?: unknown;
        idempotencyKey?: unknown;
      };
      if (typeof body.tool !== "string" || body.tool.trim().length === 0) {
        res.status(400).json({ error: '"tool" is required and must be a string' });
        return;
      }
      const result = await toolGateway.executeTool({
        sessionToken: token,
        tool: body.tool,
        parameters: body.parameters ?? {},
        timeoutMs: body.timeoutMs,
        approvedActionRequestId:
          typeof body.approvedActionRequestId === "string" ? body.approvedActionRequestId : null,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
      });
      res.json(result);
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/action-requests/:id/approve", async (req, res) => {
    try {
      assertBoard(req);
      const body = (req.body ?? {}) as { companyId?: string };
      const companyId = body.companyId ?? (typeof req.query.companyId === "string" ? req.query.companyId : null);
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const actionRequest = await toolGateway.approveActionRequest({
        companyId,
        actionRequestId: req.params.id,
        actor: {
          agentId: actor.agentId,
          userId: req.actor.type === "board" ? req.actor.userId : null,
        },
      });
      res.json(actionRequest);
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.get("/tool-gateway/runtime-slots", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const companyId =
        req.actor.type === "agent"
          ? req.actor.companyId
          : typeof req.query.companyId === "string"
            ? req.query.companyId
            : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      res.json(await toolGateway.listRuntimeSlots(companyId));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/runtime-slots/:slotId/stop", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const companyId =
        req.actor.type === "agent"
          ? req.actor.companyId
          : typeof req.body?.companyId === "string"
            ? req.body.companyId
            : typeof req.query.companyId === "string"
              ? req.query.companyId
              : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      res.json(await toolGateway.stopRuntimeSlot({
        companyId,
        slotId: req.params.slotId,
        actor: {
          agentId: actor.agentId,
          runId: req.actor.type === "agent" ? req.actor.runId : null,
        },
      }));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/runtime-slots/:slotId/restart", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const companyId =
        req.actor.type === "agent"
          ? req.actor.companyId
          : typeof req.body?.companyId === "string"
            ? req.body.companyId
            : typeof req.query.companyId === "string"
              ? req.query.companyId
              : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      res.json(await toolGateway.restartRuntimeSlot({
        companyId,
        slotId: req.params.slotId,
        actor: {
          agentId: actor.agentId,
          runId: req.actor.type === "agent" ? req.actor.runId : null,
        },
      }));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.get("/tool-gateway/audit", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const companyId =
        req.actor.type === "agent"
          ? req.actor.companyId
          : typeof req.query.companyId === "string"
            ? req.query.companyId
            : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
      const rows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.action, TOOL_GATEWAY_ACTIONS)))
        .orderBy(desc(activityLog.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  return router;
}
