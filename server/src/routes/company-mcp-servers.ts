import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyMcpServerCreateSchema,
  companyMcpServerUpdateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, logActivity } from "../services/index.js";
import { companyMcpServerService } from "../services/company-mcp-servers.js";
import { mcpOauthService } from "../services/mcp-oauth.js";
import { forbidden, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Company-level MCP server catalog routes (mirrors companySkillRoutes).
 * Servers are defined once per company; agents enable them by name from the
 * agent MCP tab (PUT /agents/:id/mcp-server-refs in agents.ts).
 */
export function companyMcpServerRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companyMcpServerService(db);
  const mcpOauth = mcpOauthService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  // Same permission gate as company skills: agents:create.
  async function assertCanMutateCompanyMcpServers(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/companies/:companyId/mcp-servers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/companies/:companyId/mcp-servers/:serverId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.detail(companyId, req.params.serverId as string));
  });

  router.post(
    "/companies/:companyId/mcp-servers",
    validate(companyMcpServerCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanyMcpServers(req, companyId);
      const actor = getActorInfo(req);
      const body = req.body as {
        name: string;
        description?: string | null;
        config: Record<string, unknown>;
        enabled?: boolean;
      };
      const created = await svc.create(
        companyId,
        body,
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
        },
        { strictMode: strictSecretsMode },
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.mcp_server_created",
        entityType: "mcp_server",
        entityId: created.id,
        details: { name: created.name, transport: created.config.transport },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/mcp-servers/:serverId",
    validate(companyMcpServerUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanyMcpServers(req, companyId);
      const updated = await svc.update(
        companyId,
        req.params.serverId as string,
        req.body as Record<string, unknown>,
        { strictMode: strictSecretsMode },
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.mcp_server_updated",
        entityType: "mcp_server",
        entityId: updated.id,
        details: { name: updated.name },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/mcp-servers/:serverId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateCompanyMcpServers(req, companyId);
    const force = req.query.force === "true";
    const result = await svc.remove(companyId, req.params.serverId as string, { force });
    if (!result.ok) {
      res.status(409).json({
        error: "MCP server is enabled on agents",
        usedByAgents: result.usedByAgents,
      });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.mcp_server_deleted",
      entityType: "mcp_server",
      entityId: result.removed.id,
      details: { name: result.removed.name },
    });
    res.json({ success: true });
  });

  // Brokered OAuth for a catalog server: the stored token is shared by every
  // agent that enables this server.
  router.post("/companies/:companyId/mcp-servers/:serverId/oauth/start", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateCompanyMcpServers(req, companyId);
    const row = await svc.getRowById(companyId, req.params.serverId as string);
    if (!row) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    const config = row.config as { transport?: unknown; url?: unknown };
    if (config.transport !== "http" && config.transport !== "sse") {
      throw unprocessable("OAuth is only supported for http/sse MCP servers");
    }
    const serverUrl = typeof config.url === "string" ? config.url : "";
    if (!serverUrl) {
      throw unprocessable("MCP server has no URL");
    }

    const forwardedProto = req.header("x-forwarded-proto");
    const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
    const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
    if (!host) throw unprocessable("Could not determine the server's public URL for OAuth redirect");

    const { authorizeUrl } = await mcpOauth.startAuthorization({
      companyId,
      target: { kind: "company_mcp_server", mcpServerId: row.id },
      serverName: row.name,
      serverUrl,
      redirectUri: `${proto}://${host}/api/mcp-oauth/callback`,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.mcp_server_oauth_started",
      entityType: "mcp_server",
      entityId: row.id,
      details: { name: row.name },
    });

    res.json({ authorizeUrl });
  });

  return router;
}
