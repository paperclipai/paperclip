import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createAgentMcpServerSchema, setAgentMcpServerStatusSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentMcpServerService, agentService, logActivity } from "../services/index.js";
import { forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { McpActor } from "../services/agent-mcp-servers.js";

export function agentMcpServerRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const svc = agentMcpServerService(db);

  /**
   * Resolve the target agent, enforce company access, and enforce that an agent
   * actor may only read its own MCP servers. Returns the resolved companyId + actor.
   */
  async function resolveContext(req: Request, agentId: string): Promise<{ companyId: string; actor: McpActor }> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const info = getActorInfo(req);
    if (info.actorType === "agent" && info.agentId !== agentId) {
      throw forbidden("Agents can only access their own MCP servers");
    }
    return { companyId: agent.companyId, actor: { actorType: info.actorType, actorId: info.actorId } };
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  // List installed MCP servers (board + owning agent). Board may include disabled.
  router.get("/agents/:agentId/mcp-servers", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const includeDisabled = actor.actorType === "user" && firstQueryString(req.query.includeDisabled) === "1";
    res.json(await svc.list(companyId, agentId, { includeDisabled }));
  });

  // Board-direct install (the agent-initiated path goes through an approval).
  router.post("/agents/:agentId/mcp-servers", validate(createAgentMcpServerSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    assertBoard(req);
    const actor: McpActor = { actorType: "user", actorId: getActorInfo(req).actorId };
    const server = await svc.create(companyId, agentId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: "agent_mcp_installed",
      entityType: "agent_mcp_server",
      entityId: server.id,
      agentId,
      details: { name: server.name, transport: server.transport, source: "board_direct" },
    });
    res.status(201).json(server);
  });

  // Enable / disable a server (board only).
  router.post(
    "/agents/:agentId/mcp-servers/:id/status",
    validate(setAgentMcpServerStatusSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const id = req.params.id as string;
      const { companyId } = await resolveContext(req, agentId);
      assertBoard(req);
      const server = await svc.setStatus(companyId, agentId, id, req.body.status);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getActorInfo(req).actorId,
        action: server.status === "enabled" ? "agent_mcp_enabled" : "agent_mcp_disabled",
        entityType: "agent_mcp_server",
        entityId: server.id,
        agentId,
        details: { name: server.name },
      });
      res.json(server);
    },
  );

  // Remove a server (board only).
  router.delete("/agents/:agentId/mcp-servers/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    assertBoard(req);
    const server = await svc.getById(companyId, agentId, id);
    await svc.remove(companyId, agentId, id);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "agent_mcp_removed",
      entityType: "agent_mcp_server",
      entityId: id,
      agentId,
      details: { name: server.name },
    });
    res.status(204).end();
  });

  return router;
}
