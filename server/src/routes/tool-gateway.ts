import { Router } from "express";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, toolApplications, toolConnections, toolInvocations } from "@paperclipai/db";
import { humanizeConnectionDisplayName, type PermissionKey } from "@paperclipai/shared";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";
import { forbidden, HttpError } from "../errors.js";
import { accessService } from "../services/index.js";

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

const TOOL_GATEWAY_WINDOWS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function gatewayToken(req: { header(name: string): string | undefined }) {
  return req.header("x-paperclip-tool-gateway-token")?.trim() || null;
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

function normalizedAuditOutcome(action: string, details: Record<string, unknown> | null | undefined) {
  const decision = detailString(details, "decision");
  if (action === "tool_gateway.call_completed" || action === "tool_gateway.call_allowed" || decision === "allow" || decision === "approved") return "allowed";
  if (action === "tool_gateway.approval_requested" || decision === "require_approval") return "asked_first";
  if (action === "tool_gateway.call_deferred" || decision === "defer_runtime") return "waiting";
  if (action === "tool_gateway.call_failed") return "failed";
  if (action === "tool_gateway.call_denied" || decision === "deny" || decision === "rate_limited") return "blocked";
  return "unknown";
}

function outcomeCondition(outcome: string) {
  if (outcome === "allowed") {
    return or(
      inArray(activityLog.action, ["tool_gateway.call_allowed", "tool_gateway.call_completed"]),
      sql`${activityLog.details}->>'decision' in ('allow', 'approved')`,
    );
  }
  if (outcome === "blocked" || outcome === "denied") {
    return or(
      eq(activityLog.action, "tool_gateway.call_denied"),
      sql`${activityLog.details}->>'decision' in ('deny', 'rate_limited')`,
    );
  }
  if (outcome === "asked_first" || outcome === "approval") {
    return or(
      eq(activityLog.action, "tool_gateway.approval_requested"),
      sql`${activityLog.details}->>'decision' = 'require_approval'`,
    );
  }
  if (outcome === "waiting" || outcome === "deferred") {
    return or(
      eq(activityLog.action, "tool_gateway.call_deferred"),
      sql`${activityLog.details}->>'decision' = 'defer_runtime'`,
    );
  }
  if (outcome === "failed") return eq(activityLog.action, "tool_gateway.call_failed");
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

  router.post("/tool-gateway/action-requests/:id/decline", async (req, res) => {
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
      const appFilter = typeof req.query.app === "string" ? req.query.app.trim() : null;
      const agentFilter = typeof req.query.agent === "string" ? req.query.agent.trim() : null;
      const outcomeFilter = typeof req.query.outcome === "string" ? req.query.outcome.trim() : null;
      const windowFilter = typeof req.query.window === "string" ? req.query.window.trim() : "24h";
      const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor.trim() : null;
      if (appFilter && !uuidPattern.test(appFilter)) {
        res.status(400).json({ error: "app must be an applicationId or connectionId UUID" });
        return;
      }
      if (agentFilter && !uuidPattern.test(agentFilter)) {
        res.status(400).json({ error: "agent must be an agentId UUID" });
        return;
      }
      if (!(windowFilter in TOOL_GATEWAY_WINDOWS)) {
        res.status(400).json({ error: "window must be one of 1h, 24h, 7d, 30d" });
        return;
      }
      const cursor = cursorRaw ? decodeAuditCursor(cursorRaw) : null;
      if (cursorRaw && !cursor) {
        res.status(400).json({ error: "Invalid audit cursor" });
        return;
      }

      const conditions = [
        eq(activityLog.companyId, companyId),
        inArray(activityLog.action, TOOL_GATEWAY_ACTIONS),
        gte(activityLog.createdAt, new Date(Date.now() - TOOL_GATEWAY_WINDOWS[windowFilter])),
      ];
      if (cursor) {
        conditions.push(or(
          lt(activityLog.createdAt, cursor.createdAt),
          and(eq(activityLog.createdAt, cursor.createdAt), lt(activityLog.id, cursor.id)),
        )!);
      }
      if (appFilter) {
        conditions.push(or(
          eq(toolInvocations.applicationId, appFilter),
          eq(toolInvocations.connectionId, appFilter),
          sql`${activityLog.details}->>'applicationId' = ${appFilter}`,
          sql`${activityLog.details}->>'connectionId' = ${appFilter}`,
        )!);
      }
      if (agentFilter) {
        conditions.push(or(
          eq(activityLog.agentId, agentFilter),
          eq(toolInvocations.agentId, agentFilter),
          sql`${activityLog.details}->>'agentId' = ${agentFilter}`,
        )!);
      }
      const outcomeWhere = outcomeFilter ? outcomeCondition(outcomeFilter) : null;
      if (outcomeWhere) conditions.push(outcomeWhere);

      const page = await db
        .select({
          row: activityLog,
          invocationId: toolInvocations.id,
          invocationAgentId: toolInvocations.agentId,
          invocationApplicationId: toolInvocations.applicationId,
          invocationConnectionId: toolInvocations.connectionId,
          invocationToolName: toolInvocations.toolName,
        })
        .from(activityLog)
        .leftJoin(
          toolInvocations,
          and(
            eq(toolInvocations.companyId, companyId),
            sql`${toolInvocations.id}::text = ${activityLog.details}->>'invocationId'`,
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(limit + 1);

      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      const agentIds = [...new Set(visible.flatMap((item) => [
        item.row.agentId,
        item.invocationAgentId,
        detailString(item.row.details, "agentId"),
      ]).filter((id): id is string => Boolean(id)))];
      const applicationIds = [...new Set(visible.flatMap((item) => [
        item.invocationApplicationId,
        detailString(item.row.details, "applicationId"),
      ]).filter((id): id is string => Boolean(id)))];
      const connectionIds = [...new Set(visible.flatMap((item) => [
        item.invocationConnectionId,
        detailString(item.row.details, "connectionId"),
      ]).filter((id): id is string => Boolean(id)))];
      const [agentRows, applicationRows, connectionRows] = await Promise.all([
        agentIds.length > 0
          ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
          : [],
        applicationIds.length > 0
          ? db.select({ id: toolApplications.id, name: toolApplications.name }).from(toolApplications).where(and(eq(toolApplications.companyId, companyId), inArray(toolApplications.id, applicationIds)))
          : [],
        connectionIds.length > 0
          ? db.select({ id: toolConnections.id, name: toolConnections.name, applicationId: toolConnections.applicationId }).from(toolConnections).where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, connectionIds)))
          : [],
      ]);
      const agentsById = new Map(agentRows.map((row) => [row.id, row]));
      const applicationsById = new Map(applicationRows.map((row) => [row.id, row]));
      const connectionsById = new Map(connectionRows.map((row) => [row.id, row]));

      const events = visible.map((item) => {
        const row = item.row;
        const details = row.details ?? null;
        const agentId = row.agentId ?? item.invocationAgentId ?? detailString(details, "agentId");
        const connectionId = item.invocationConnectionId ?? detailString(details, "connectionId");
        const connection = connectionId ? connectionsById.get(connectionId) ?? null : null;
        const applicationId = item.invocationApplicationId ?? detailString(details, "applicationId") ?? connection?.applicationId ?? null;
        const application = applicationId ? applicationsById.get(applicationId) ?? null : null;
        const rawToolName = item.invocationToolName ?? detailString(details, "tool") ?? detailString(details, "toolName");
        const appDisplayName = connection
          ? humanizeConnectionDisplayName(connection)
          : application
            ? humanizeConnectionDisplayName(application.name)
            : null;
        return {
          ...row,
          agentId,
          agentDisplayName: agentId ? agentsById.get(agentId)?.name ?? "Unknown agent" : null,
          applicationId,
          connectionId,
          appDisplayName,
          applicationDisplayName: application ? humanizeConnectionDisplayName(application.name) : null,
          connectionDisplayName: connection ? humanizeConnectionDisplayName(connection) : null,
          toolDisplayName: rawToolName ? humanizeConnectionDisplayName(rawToolName) : null,
          normalizedOutcome: normalizedAuditOutcome(row.action, details),
        };
      });

      const last = visible.at(-1)?.row;
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
