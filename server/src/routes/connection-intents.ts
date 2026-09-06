import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
  completeConnectionIntentSchema,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  declineConnectionIntentSchema,
} from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function bearer(req: Request) {
  const value = req.header("authorization") ?? "";
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function runtimeClaims(req: Request) {
  const claims = verifyRuntimeToolsToken(bearer(req));
  if (!claims) throw unauthorized("Runtime tools token is missing, invalid, or expired");
  return claims;
}

function resultContent(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
] as const;

/** Public, token-authenticated routes mounted before the general actor middleware. */
export function runtimeConnectionIntentRoutes(db: Db) {
  const router = Router();
  const service = connectionIntentService(db);

  router.get("/mcp/runtime-tools", async (req, res) => {
    await service.validate(runtimeClaims(req));
    res.json({ name: "paperclip-runtime-tools", protocolVersion: "2025-03-26" });
  });

  router.post("/mcp/runtime-tools", async (req, res) => {
    const claims = runtimeClaims(req);
    // Streamable HTTP lifecycle calls are token uses too. Revalidate the bound
    // run before initialize/list as well as before an actual tool call so an
    // ended heartbeat cannot keep probing the endpoint with a once-valid token.
    await service.validate(claims);
    const request = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    const id = request.id ?? null;
    if (request.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paperclip-runtime-tools", version: "1" },
        },
      });
      return;
    }
    if (request.method === "notifications/initialized") {
      res.status(202).end();
      return;
    }
    if (request.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: RUNTIME_CONNECTION_TOOL_DEFINITIONS,
        },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object"
        ? request.params as { name?: unknown; arguments?: unknown }
        : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "connections_search") {
        const input = connectionsSearchInputSchema.parse(params.arguments ?? {});
        const result = await service.search(claims, input.query);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      if (name === "connection_request") {
        const input = connectionRequestInputSchema.parse(params.arguments ?? {});
        const result = await service.request(claims, input.service);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name || "missing"}` },
      });
      return;
    }
    res.status(404).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${request.method ?? "missing"}` },
    });
  });

  router.post("/runtime-tools/connections/search", async (req, res) => {
    const input = connectionsSearchInputSchema.parse(req.body ?? {});
    res.json(await service.search(runtimeClaims(req), input.query));
  });
  router.post("/runtime-tools/connections/request", async (req, res) => {
    const input = connectionRequestInputSchema.parse(req.body ?? {});
    res.json(await service.request(runtimeClaims(req), input.service));
  });
  return router;
}

type Heartbeat = ReturnType<typeof heartbeatService>;

export async function wakeConnectionIntentAfterResolution(
  heartbeat: Pick<Heartbeat, "wakeup">,
  input: {
    loaded: {
      issue: { id: string; assigneeAgentId: string | null; status: string };
      interaction: { id: string; resolvedAt?: string | Date | null };
    };
    status: string;
    actorId: string;
  },
) {
  const agentId = input.loaded.issue.assigneeAgentId;
  if (!agentId || input.loaded.issue.status !== "in_progress") return;
  const resolvedAt = input.loaded.interaction.resolvedAt;
  const interactionResolvedAt = resolvedAt instanceof Date ? resolvedAt.toISOString() : resolvedAt;
  await heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.loaded.issue.id,
      interactionId: input.loaded.interaction.id,
      interactionKind: "connection_intent",
      interactionStatus: input.status,
      mutation: "interaction",
    },
    idempotencyKey: `interaction:${input.loaded.interaction.id}:${input.status}`,
    requestedByActorType: "user",
    requestedByActorId: input.actorId,
    contextSnapshot: {
      issueId: input.loaded.issue.id,
      taskId: input.loaded.issue.id,
      interactionId: input.loaded.interaction.id,
      interactionKind: "connection_intent",
      interactionStatus: input.status,
      mutation: "interaction",
      wakeReason: "issue_commented",
      source: "connection_intent.resolved",
      ...(interactionResolvedAt
        ? { interactionResolvedAt }
        : {}),
      forceFreshSession: true,
    },
    issueStateGuard: {
      statuses: ["in_progress"],
      assigneeAgentId: agentId,
    },
  });
}

export function connectionIntentBoardRoutes(db: Db, heartbeat: Heartbeat) {
  const router = Router();
  const service = connectionIntentService(db);
  const access = accessService(db);

  function bypassCurrentMembershipCheck(req: Request) {
    return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  }

  async function canManageCompanyConnections(req: Request, companyId: string) {
    if (bypassCurrentMembershipCheck(req)) return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function addressedIntent(req: Request) {
    assertBoard(req);
    const loaded = await service.loadIntent(req.params.interactionId as string);
    assertCompanyAccess(req, loaded.issue.companyId);
    const userId = req.actor.userId ?? "local-board";
    if (loaded.interaction.addresseeUserId !== userId) {
      throw forbidden("Only the addressed user can act on this connection request");
    }
    return { loaded, userId };
  }

  async function wakeAfterResolution(input: {
    loaded: Awaited<ReturnType<typeof service.loadIntent>>;
    status: string;
    actorId: string;
  }) {
    // The operator may park or reassign the issue while the connection work
    // and activity write are in flight. Re-read immediately before enqueueing
    // so the wake decision is not made from addressedIntent's stale snapshot.
    const current = await service.loadIntent(input.loaded.interaction.id);
    await wakeConnectionIntentAfterResolution(heartbeat, {
      ...input,
      loaded: current,
    });
  }

  router.get("/connection-intents/:interactionId/setup-options", async (req, res) => {
    await addressedIntent(req);
    res.json(await service.setupOptions(req.params.interactionId as string));
  });

  router.post("/connection-intents/:interactionId/phase", async (req, res) => {
    const { userId } = await addressedIntent(req);
    const phase = req.body?.phase;
    if (phase !== "requested" && phase !== "authorizing" && phase !== "needs_retry") {
      res.status(422).json({ error: "phase must be requested, authorizing, or needs_retry" });
      return;
    }
    res.json(await service.updatePhase(req.params.interactionId as string, phase, userId, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    }));
  });

  router.post("/connection-intents/:interactionId/complete", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = completeConnectionIntentSchema.parse(req.body);
    const interaction = await service.complete(loaded.interaction.id, input.connectionId, userId, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_connected",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: {
        interactionId: interaction.id,
        connectionId: interaction.result?.connectionId ?? null,
        requestingAgentId: interaction.payload.requestingAgentId,
      },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  router.post("/connection-intents/:interactionId/decline", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = declineConnectionIntentSchema.parse(req.body ?? {});
    const interaction = await service.decline(loaded.interaction.id, userId, input.reason, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_declined",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: { interactionId: interaction.id, reason: input.reason ?? null },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  return router;
}
