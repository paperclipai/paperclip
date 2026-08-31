import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, toolApplications, toolCallEvents, toolConnections, toolInvocations } from "@paperclipai/db";
import {
  humanizeConnectionDisplayName,
  type PermissionKey,
  type ToolConnectionLifecycleEventType,
} from "@paperclipai/shared";
import {
  createToolMcpGatewaySchema,
  createToolMcpGatewayTokenSchema,
  updateToolMcpGatewaySchema,
} from "@paperclipai/shared/validators/tool-access";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";
import { forbidden, HttpError } from "../errors.js";
import { accessService } from "../services/index.js";
import { listConnectionLifecycleEvents } from "../services/tool-connection-activity.js";

const TOOL_ACTIVITY_EVENT_TYPES = [
  "call_completed",
  "call_failed",
  "call_denied",
  "approval_requested",
  "approval_resolved",
] as const;

const TOOL_GATEWAY_WINDOWS: Record<string, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function gatewayToken(req: { header(name: string): string | undefined }) {
  return req.header("x-paperclip-tool-gateway-token")?.trim() || null;
}

function bearerToken(req: { header(name: string): string | undefined }) {
  const value = req.header("authorization")?.trim() ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function callerHeaders(req: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

async function handleMcpGatewayProtocol(
  req: Request,
  res: Response,
  toolGateway: ToolGatewayService,
  locator: { gatewayId?: string | null; gatewayPublicId?: string | null },
) {
  try {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Bearer token is required" });
      return;
    }
    const headers = callerHeaders(req);
    const body = (req.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = body.id ?? null;
    if (body.method === "initialize") {
      await toolGateway.initializeNamedGatewayProtocol({
        ...locator,
        bearerToken: token,
        callerHeaders: headers,
      });
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Paperclip MCP Gateway", version: "1.0.0" },
        },
      });
      return;
    }
    if (body.method === "notifications/initialized") {
      res.status(202).end();
      return;
    }
    if (body.method === "tools/list") {
      const tools = await toolGateway.listToolsForNamedGateway({
        ...locator,
        bearerToken: token,
        callerHeaders: headers,
      });
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.displayName,
            description: tool.description,
            inputSchema: tool.parametersSchema ?? { type: "object", properties: {} },
          })),
        },
      });
      return;
    }
    if (body.method === "tools/call") {
      const params = body.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32602, message: "params.name is required" } });
        return;
      }
      const result = await toolGateway.executeTool({
        sessionToken: token,
        gatewayId: locator.gatewayId ?? null,
        gatewayPublicId: locator.gatewayPublicId ?? null,
        tool: name,
        parameters: params.arguments ?? {},
        callerHeaders: req.headers,
      });
      const resultRecord = result.result && typeof result.result === "object" && !Array.isArray(result.result)
        ? result.result as Record<string, unknown>
        : null;
      const contentText = typeof resultRecord?.content === "string"
        ? resultRecord.content
        : JSON.stringify(resultRecord?.data ?? result.result ?? null);
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: contentText }],
          structuredContent: resultRecord?.data ?? null,
          isError: false,
        },
      });
      return;
    }
    res.status(404).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (err) {
    if (err instanceof ToolGatewayHttpError) {
      const id = (req.body as { id?: unknown } | undefined)?.id ?? null;
      res.status(err.status).json({
        jsonrpc: "2.0",
        id,
        error: { code: err.status >= 500 ? -32603 : -32000, message: err.message, data: { reasonCode: err.reasonCode, ...err.details } },
      });
      return;
    }
    sendGatewayError(res, err);
  }
}

export function mcpGatewayProtocolRoutes(toolGateway: ToolGatewayService) {
  const router = Router();
  router.get("/mcp/gateways/:gatewayPublicId", async (req, res) => {
    res.json({
      transport: "streamable_http",
      endpoint: `/mcp/gateways/${req.params.gatewayPublicId}`,
      authentication: "bearer",
    });
  });
  router.post("/mcp/gateways/:gatewayPublicId", async (req, res) => {
    await handleMcpGatewayProtocol(req, res, toolGateway, { gatewayPublicId: req.params.gatewayPublicId });
  });
  return router;
}

function detailString(details: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function encodeAuditCursor(input: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: input.createdAt.toISOString(), id: input.id }), "utf8").toString("base64url");
}

function decodeAuditCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
    const id = typeof parsed.id === "string" ? parsed.id : null;
    if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function toolActivityAction(eventType: string): string {
  return `tool_gateway.${eventType}`;
}

function normalizedAuditOutcome(
  eventType: string,
  outcome: string,
  decision: string | null,
) {
  if (eventType === "approval_requested") return "asked_first";
  if (decision === "defer_runtime") return "waiting";
  if (eventType === "call_denied" || outcome === "denied" || decision === "deny") return "blocked";
  if (eventType === "call_failed" || ["failure", "timeout", "cancelled"].includes(outcome)) return "failed";
  if (eventType === "call_completed" || eventType === "approval_resolved" || outcome === "success" || decision === "allow") return "allowed";
  return "unknown";
}

function outcomeCondition(outcome: string) {
  if (outcome === "allowed") {
    return or(
      eq(toolCallEvents.eventType, "call_completed"),
      and(eq(toolCallEvents.eventType, "approval_resolved"), eq(toolCallEvents.outcome, "success")),
      eq(toolCallEvents.decision, "allow"),
    );
  }
  if (outcome === "blocked" || outcome === "denied") {
    return or(
      eq(toolCallEvents.eventType, "call_denied"),
      eq(toolCallEvents.outcome, "denied"),
      eq(toolCallEvents.decision, "deny"),
    );
  }
  if (outcome === "asked_first" || outcome === "approval") {
    return eq(toolCallEvents.eventType, "approval_requested");
  }
  if (outcome === "waiting" || outcome === "deferred") {
    return eq(toolCallEvents.decision, "defer_runtime");
  }
  if (outcome === "failed") {
    return and(
      or(
        eq(toolCallEvents.eventType, "call_failed"),
        inArray(toolCallEvents.outcome, ["failure", "timeout", "cancelled"]),
      ),
      sql`${toolCallEvents.decision} is distinct from 'defer_runtime'`,
    );
  }
  return null;
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
  if (err instanceof HttpError) {
    const details =
      err.details && typeof err.details === "object" && !Array.isArray(err.details)
        ? err.details as Record<string, unknown>
        : {};
    res.status(err.status).json({ error: err.message, ...details });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

export function toolGatewayRoutes(db: Db, toolGateway: ToolGatewayService) {
  const router = Router();
  const access = accessService(db);

  async function assertBoardPermission(req: import("express").Request, companyId: string, permissionKey: PermissionKey) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (req.actor.userId && await access.canUser(companyId, req.actor.userId, permissionKey)) return;
    throw forbidden(`Missing permission: ${permissionKey}`);
  }

  function assertBoardMutationAccess(req: import("express").Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : null;
    if (!membership || membership.status !== "active") {
      throw forbidden("User does not have active company access");
    }
    if (!membership.membershipRole || membership.membershipRole === "viewer") {
      throw forbidden("Viewer access is read-only");
    }
  }

  router.get("/companies/:companyId/tools/gateways", async (req, res) => {
    try {
      await assertBoardPermission(req, req.params.companyId, "tools:admin");
      res.json({ gateways: await toolGateway.listNamedGateways(req.params.companyId) });
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/companies/:companyId/tools/gateways", async (req, res) => {
    try {
      await assertBoardPermission(req, req.params.companyId, "tools:admin");
      const parsed = createToolMcpGatewaySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(422).json({ error: "Invalid gateway payload", issues: parsed.error.issues });
        return;
      }
      const actor = getActorInfo(req);
      const gateway = await toolGateway.createNamedGateway({
        companyId: req.params.companyId,
        body: parsed.data,
        actor: { agentId: actor.agentId, userId: req.actor.type === "board" ? req.actor.userId : null },
      });
      res.status(201).json(gateway);
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.patch("/tool-gateway/gateways/:gatewayId", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = typeof req.body?.companyId === "string" ? req.body.companyId : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:admin");
      const parsed = updateToolMcpGatewaySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(422).json({ error: "Invalid gateway payload", issues: parsed.error.issues });
        return;
      }
      const { companyId: _companyId, ...body } = parsed.data as typeof parsed.data & { companyId?: string };
      res.json(await toolGateway.updateNamedGateway({ companyId, gatewayId: req.params.gatewayId, body }));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/gateways/:gatewayId/tokens", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = typeof req.body?.companyId === "string" ? req.body.companyId : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:admin");
      const parsed = createToolMcpGatewayTokenSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(422).json({ error: "Invalid gateway token payload", issues: parsed.error.issues });
        return;
      }
      const actor = getActorInfo(req);
      res.status(201).json(await toolGateway.createNamedGatewayToken({
        companyId,
        gatewayId: req.params.gatewayId,
        body: parsed.data,
        actor: { agentId: actor.agentId, userId: req.actor.type === "board" ? req.actor.userId : null },
      }));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/gateway-tokens/:tokenId/revoke", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = typeof req.body?.companyId === "string" ? req.body.companyId : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:admin");
      res.json(await toolGateway.revokeNamedGatewayToken({ companyId, tokenId: req.params.tokenId }));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.get("/tool-gateway/gateways/:gatewayId/mcp", async (req, res) => {
    res.json({
      transport: "streamable_http",
      endpoint: `/api/tool-gateway/gateways/${req.params.gatewayId}/mcp`,
      authentication: "bearer",
    });
  });

  router.post("/tool-gateway/gateways/:gatewayId/mcp", async (req, res) => {
    await handleMcpGatewayProtocol(req, res, toolGateway, { gatewayId: req.params.gatewayId });
  });

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

  router.post("/tool-gateway/sessions/:sessionId/revoke", async (req, res) => {
    try {
      assertBoardOrAgent(req);
      const actor = getActorInfo(req);
      const body = (req.body ?? {}) as { companyId?: string };
      const companyId = req.actor.type === "agent" ? req.actor.companyId : body.companyId;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertCompanyAccess(req, companyId);
      if (req.actor.type === "agent" && !req.actor.agentId) {
        throw forbidden("Agent authentication required");
      }

      const revoked = await toolGateway.revokeSession({
        companyId,
        sessionId: req.params.sessionId,
        actor: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
        },
        agentScope: req.actor.type === "agent"
          ? { agentId: req.actor.agentId!, runId: req.actor.runId ?? null }
          : null,
      });
      res.json({
        sessionId: revoked.id,
        revokedAt: revoked.revokedAt.toISOString(),
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
        callerHeaders: callerHeaders(req),
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
      assertBoardMutationAccess(req, companyId);
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

  router.post("/tool-gateway/action-requests/:id/decline", async (req, res) => {
    try {
      assertBoard(req);
      const body = (req.body ?? {}) as { companyId?: string };
      const companyId = body.companyId ?? (typeof req.query.companyId === "string" ? req.query.companyId : null);
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      assertBoardMutationAccess(req, companyId);
      const actor = getActorInfo(req);
      const actionRequest = await toolGateway.declineActionRequest({
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
      assertBoard(req);
      const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:manage_runtime");
      res.json(await toolGateway.listRuntimeSlots(companyId));
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  router.post("/tool-gateway/runtime-slots/:slotId/stop", async (req, res) => {
    try {
      const companyId =
        typeof req.body?.companyId === "string"
          ? req.body.companyId
          : typeof req.query.companyId === "string"
            ? req.query.companyId
            : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:manage_runtime");
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
      const companyId =
        typeof req.body?.companyId === "string"
          ? req.body.companyId
          : typeof req.query.companyId === "string"
            ? req.query.companyId
            : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:manage_runtime");
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
      assertBoard(req);
      const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
      if (!companyId) {
        res.status(400).json({ error: "companyId is required" });
        return;
      }
      await assertBoardPermission(req, companyId, "tools:view_audit");
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 100;
      const gatewayFilter = typeof req.query.gateway === "string" ? req.query.gateway.trim() : null;
      const appFilter = typeof req.query.app === "string" ? req.query.app.trim() : null;
      const agentFilter = typeof req.query.agent === "string" ? req.query.agent.trim() : null;
      const outcomeFilter = typeof req.query.outcome === "string" ? req.query.outcome.trim() : null;
      const windowFilter = typeof req.query.window === "string" ? req.query.window.trim() : "all";
      const searchRaw = typeof req.query.search === "string" ? req.query.search.trim() : null;
      const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor.trim() : null;
      if (gatewayFilter && !uuidPattern.test(gatewayFilter)) {
        res.status(400).json({ error: "gateway must be a gateway UUID" });
        return;
      }
      if (appFilter && !uuidPattern.test(appFilter)) {
        res.status(400).json({ error: "app must be an applicationId or connectionId UUID" });
        return;
      }
      if (agentFilter && !uuidPattern.test(agentFilter)) {
        res.status(400).json({ error: "agent must be an agentId UUID" });
        return;
      }
      if (!(windowFilter in TOOL_GATEWAY_WINDOWS)) {
        res.status(400).json({ error: "window must be one of 1h, 24h, 7d, 30d, all" });
        return;
      }
      const cursor = cursorRaw ? decodeAuditCursor(cursorRaw) : null;
      if (cursorRaw && !cursor) {
        res.status(400).json({ error: "Invalid audit cursor" });
        return;
      }

      const windowMs = TOOL_GATEWAY_WINDOWS[windowFilter];
      const windowStartedAt = windowMs === null ? null : new Date(Date.now() - windowMs);
      const conditions = [
        eq(toolCallEvents.companyId, companyId),
        inArray(toolCallEvents.eventType, TOOL_ACTIVITY_EVENT_TYPES),
      ];
      if (windowStartedAt) conditions.push(gte(toolCallEvents.createdAt, windowStartedAt));
      if (cursor) {
        conditions.push(or(
          lt(toolCallEvents.createdAt, cursor.createdAt),
          and(eq(toolCallEvents.createdAt, cursor.createdAt), lt(toolCallEvents.id, cursor.id)),
        )!);
      }
      if (gatewayFilter) {
        conditions.push(or(
          eq(toolCallEvents.gatewayId, gatewayFilter),
          eq(toolInvocations.gatewayId, gatewayFilter),
        )!);
      }
      if (appFilter) {
        conditions.push(or(
          eq(toolCallEvents.applicationId, appFilter),
          eq(toolCallEvents.connectionId, appFilter),
          eq(toolInvocations.applicationId, appFilter),
          eq(toolInvocations.connectionId, appFilter),
        )!);
      }
      if (agentFilter) {
        conditions.push(or(
          eq(toolCallEvents.agentId, agentFilter),
          eq(toolInvocations.agentId, agentFilter),
        )!);
      }
      const outcomeWhere = outcomeFilter ? outcomeCondition(outcomeFilter) : null;
      if (outcomeWhere) conditions.push(outcomeWhere);

      // Free-text search runs server-side: resolve the term against agent / app /
      // connection names first, then OR those matched IDs with direct matches on
      // the event type, tool name, and reason code so paginating stays honest.
      let matchedAgentIds: string[] = [];
      let matchedConnectionIds: string[] = [];
      if (searchRaw) {
        const like = `%${searchRaw.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
        const [matchAgents, matchApps, matchConnections] = await Promise.all([
          db.select({ id: agents.id }).from(agents)
            .where(and(eq(agents.companyId, companyId), ilike(agents.name, like))),
          db.select({ id: toolApplications.id }).from(toolApplications)
            .where(and(eq(toolApplications.companyId, companyId), ilike(toolApplications.name, like))),
          db.select({ id: toolConnections.id }).from(toolConnections)
            .where(and(eq(toolConnections.companyId, companyId), ilike(toolConnections.name, like))),
        ]);
        matchedAgentIds = matchAgents.map((r) => r.id);
        const matchedAppIds = matchApps.map((r) => r.id);
        matchedConnectionIds = matchConnections.map((r) => r.id);
        if (matchedAppIds.length > 0) {
          const appConnections = await db
            .select({ id: toolConnections.id })
            .from(toolConnections)
            .where(and(
              eq(toolConnections.companyId, companyId),
              inArray(toolConnections.applicationId, matchedAppIds),
            ));
          matchedConnectionIds = [...new Set([
            ...matchedConnectionIds,
            ...appConnections.map((connection) => connection.id),
          ])];
        }
        const searchClauses = [
          ilike(toolCallEvents.eventType, like),
          ilike(toolCallEvents.toolName, like),
          ilike(toolCallEvents.reasonCode, like),
          sql`${toolCallEvents.metadata}->>'upstreamToolName' ilike ${like}`,
          ilike(toolInvocations.toolName, like),
        ];
        if (matchedAgentIds.length > 0) {
          searchClauses.push(inArray(toolCallEvents.agentId, matchedAgentIds));
          searchClauses.push(inArray(toolInvocations.agentId, matchedAgentIds));
        }
        if (matchedAppIds.length > 0) {
          searchClauses.push(inArray(toolCallEvents.applicationId, matchedAppIds));
          searchClauses.push(inArray(toolInvocations.applicationId, matchedAppIds));
        }
        if (matchedConnectionIds.length > 0) {
          searchClauses.push(inArray(toolCallEvents.connectionId, matchedConnectionIds));
          searchClauses.push(inArray(toolInvocations.connectionId, matchedConnectionIds));
        }
        conditions.push(or(...searchClauses)!);
      }

      const page = await db
        .select({
          row: toolCallEvents,
          invocationId: toolInvocations.id,
          invocationAgentId: toolInvocations.agentId,
          invocationApplicationId: toolInvocations.applicationId,
          invocationConnectionId: toolInvocations.connectionId,
          invocationToolName: toolInvocations.toolName,
          invocationStatus: toolInvocations.status,
          invocationPolicyDecision: toolInvocations.policyDecision,
          invocationApprovalState: toolInvocations.approvalState,
          invocationArgumentsSummary: toolInvocations.argumentsSummary,
          invocationResultSummary: toolInvocations.resultSummary,
          invocationResultSizeBytes: toolInvocations.resultSizeBytes,
          invocationErrorCode: toolInvocations.errorCode,
          invocationErrorMessage: toolInvocations.errorMessage,
          invocationStartedAt: toolInvocations.startedAt,
          invocationCompletedAt: toolInvocations.completedAt,
        })
        .from(toolCallEvents)
        .leftJoin(
          toolInvocations,
          and(
            eq(toolInvocations.companyId, companyId),
            eq(toolInvocations.id, toolCallEvents.invocationId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(toolCallEvents.createdAt), desc(toolCallEvents.id))
        .limit(limit + 1);

      let lifecycleConnectionIds: string[] | undefined;
      if (gatewayFilter || outcomeFilter) {
        lifecycleConnectionIds = [];
      } else if (appFilter) {
        lifecycleConnectionIds = (await db
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(and(
            eq(toolConnections.companyId, companyId),
            or(eq(toolConnections.id, appFilter), eq(toolConnections.applicationId, appFilter)),
          )))
          .map((row) => row.id);
      }

      const lifecycleEvents = await listConnectionLifecycleEvents(db, {
        companyId,
        connectionIds: lifecycleConnectionIds,
        agentId: agentFilter,
        since: windowStartedAt,
        cursor,
        search: searchRaw,
        matchedAgentIds,
        matchedConnectionIds,
        limit: limit + 1,
      });
      const candidates = [
        ...page.map((item) => ({ kind: "call" as const, id: item.row.id, createdAt: item.row.createdAt, item })),
        ...lifecycleEvents.map((item) => ({ kind: "lifecycle" as const, id: item.id, createdAt: item.createdAt, item })),
      ].sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
      });
      const hasMore = candidates.length > limit;
      const visible = candidates.slice(0, limit);
      const agentIds = [...new Set(visible.flatMap((item) => [
        item.kind === "call" ? item.item.row.agentId : item.item.agentId,
        item.kind === "call" ? item.item.invocationAgentId : null,
      ]).filter((id): id is string => Boolean(id)))];
      const applicationIds = [...new Set(visible.flatMap((item) => [
        item.kind === "call" ? item.item.row.applicationId : null,
        item.kind === "call" ? item.item.invocationApplicationId : null,
      ]).filter((id): id is string => Boolean(id)))];
      const connectionIds = [...new Set(visible.flatMap((item) => [
        item.kind === "call" ? item.item.row.connectionId : item.item.connectionId,
        item.kind === "call" ? item.item.invocationConnectionId : null,
      ]).filter((id): id is string => Boolean(id)))];
      const [agentRows, connectionRows] = await Promise.all([
        agentIds.length > 0
          ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
          : [],
        connectionIds.length > 0
          ? db.select({ id: toolConnections.id, name: toolConnections.name, applicationId: toolConnections.applicationId }).from(toolConnections).where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, connectionIds)))
          : [],
      ]);
      const allApplicationIds = [...new Set([
        ...applicationIds,
        ...connectionRows.map((row) => row.applicationId),
      ])];
      const applicationRows = allApplicationIds.length > 0
        ? await db.select({ id: toolApplications.id, name: toolApplications.name }).from(toolApplications)
          .where(and(eq(toolApplications.companyId, companyId), inArray(toolApplications.id, allApplicationIds)))
        : [];
      const agentsById = new Map(agentRows.map((row) => [row.id, row]));
      const applicationsById = new Map(applicationRows.map((row) => [row.id, row]));
      const connectionsById = new Map(connectionRows.map((row) => [row.id, row]));

      const events = visible.map((candidate) => {
        if (candidate.kind === "lifecycle") {
          const lifecycle = candidate.item;
          const connection = connectionsById.get(lifecycle.connectionId) ?? null;
          const applicationId = connection?.applicationId ?? null;
          const application = applicationId ? applicationsById.get(applicationId) ?? null : null;
          const appDisplayName = connection
            ? humanizeConnectionDisplayName(connection)
            : application
              ? humanizeConnectionDisplayName(application.name)
              : null;
          return {
            id: lifecycle.id,
            companyId,
            action: `tool_connection.${lifecycle.type}`,
            actorType: lifecycle.actorType,
            actorId: lifecycle.actorId,
            entityType: "tool_connection",
            entityId: lifecycle.connectionId,
            details: { ...(lifecycle.details ?? {}), lifecycleType: lifecycle.type },
            createdAt: lifecycle.createdAt,
            runId: null,
            agentId: lifecycle.agentId,
            agentDisplayName: lifecycle.agentId
              ? agentsById.get(lifecycle.agentId)?.name ?? "Unknown agent"
              : null,
            actorDisplayName: lifecycle.actorDisplayName,
            applicationId,
            connectionId: lifecycle.connectionId,
            appDisplayName,
            applicationDisplayName: application ? humanizeConnectionDisplayName(application.name) : null,
            connectionDisplayName: connection ? humanizeConnectionDisplayName(connection) : null,
            toolDisplayName: null,
            lifecycleType: lifecycle.type,
            normalizedOutcome: "unknown" as const,
            invocation: null,
          };
        }

        const item = candidate.item;
        const row = item.row;
        const agentId = row.agentId ?? item.invocationAgentId;
        const connectionId = row.connectionId ?? item.invocationConnectionId;
        const connection = connectionId ? connectionsById.get(connectionId) ?? null : null;
        const applicationId = row.applicationId ?? item.invocationApplicationId ?? connection?.applicationId ?? null;
        const application = applicationId ? applicationsById.get(applicationId) ?? null : null;
        const rawToolName = row.toolName ?? item.invocationToolName;
        const appDisplayName = connection
          ? humanizeConnectionDisplayName(connection)
          : application
            ? humanizeConnectionDisplayName(application.name)
            : null;
        const details = {
          ...(row.metadata ?? {}),
          invocationId: row.invocationId,
          actionRequestId: row.actionRequestId,
          gatewayId: row.gatewayId,
          agentId,
          issueId: row.issueId,
          runId: row.runId,
          applicationId,
          connectionId,
          tool: rawToolName,
          toolName: rawToolName,
          decision: row.decision,
          matchedPolicyIds: row.matchedPolicyIds,
          reasonCode: row.reasonCode,
          argumentsSummary: row.argumentsSummary ?? row.requestSummary,
          resultSummary: row.resultSummary,
          latencyMs: row.latencyMs,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
        };
        return {
          id: row.id,
          companyId: row.companyId,
          action: toolActivityAction(row.eventType),
          actorType: row.actorType,
          actorId: row.actorId,
          entityType: "tool_connection",
          entityId: connectionId,
          details,
          createdAt: row.createdAt,
          runId: row.runId,
          agentId,
          agentDisplayName: agentId ? agentsById.get(agentId)?.name ?? "Unknown agent" : null,
          actorDisplayName: agentId ? agentsById.get(agentId)?.name ?? "Unknown agent" : null,
          applicationId,
          connectionId,
          appDisplayName,
          applicationDisplayName: application ? humanizeConnectionDisplayName(application.name) : null,
          connectionDisplayName: connection ? humanizeConnectionDisplayName(connection) : null,
          toolDisplayName: rawToolName ? humanizeConnectionDisplayName(rawToolName) : null,
          lifecycleType: null as ToolConnectionLifecycleEventType | null,
          normalizedOutcome: normalizedAuditOutcome(row.eventType, row.outcome, row.decision),
          invocation: item.invocationId && item.invocationToolName && item.invocationStatus && item.invocationApprovalState
            ? {
                id: item.invocationId,
                toolName: item.invocationToolName,
                status: item.invocationStatus,
                policyDecision: item.invocationPolicyDecision,
                approvalState: item.invocationApprovalState,
                argumentsSummary: item.invocationArgumentsSummary,
                resultSummary: item.invocationResultSummary,
                resultSizeBytes: item.invocationResultSizeBytes,
                errorCode: item.invocationErrorCode,
                errorMessage: item.invocationErrorMessage,
                startedAt: item.invocationStartedAt,
                completedAt: item.invocationCompletedAt,
              }
            : null,
        };
      });

      const last = visible.at(-1);
      res.json({
        events,
        nextCursor: hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null,
      });
    } catch (err) {
      sendGatewayError(res, err);
    }
  });

  return router;
}
