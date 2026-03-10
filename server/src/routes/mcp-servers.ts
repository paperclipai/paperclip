import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMcpServerSchema,
  updateMcpServerSchema,
  assignMcpServersSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, mcpServerService, agentService } from "../services/index.js";

export function mcpServerRoutes(db: Db) {
  const router = Router();
  const svc = mcpServerService(db);
  const agentSvc = agentService(db);

  // List MCP servers for a company
  router.get("/companies/:companyId/mcp-servers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const servers = await svc.list(companyId);
    res.json(servers);
  });

  // Create MCP server
  router.post("/companies/:companyId/mcp-servers", validate(createMcpServerSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(companyId, req.body);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.created",
      entityType: "mcp_server",
      entityId: created.id,
      details: { name: created.name, transportType: created.transportType },
    });

    res.status(201).json(created);
  });

  // Get single MCP server
  router.get("/mcp-servers/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const server = await svc.getById(id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, server.companyId);
    res.json(server);
  });

  // Update MCP server
  router.patch("/mcp-servers/:id", validate(updateMcpServerSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const updated = await svc.update(id, req.body);
    if (!updated) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.updated",
      entityType: "mcp_server",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  // Delete MCP server
  router.delete("/mcp-servers/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.deleted",
      entityType: "mcp_server",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  // List MCP servers assigned to an agent
  router.get("/agents/:agentId/mcp-servers", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const agent = await agentSvc.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const servers = await svc.listForAgent(agentId);
    res.json(servers);
  });

  // Set MCP servers for an agent (full replacement)
  router.put("/agents/:agentId/mcp-servers", validate(assignMcpServersSchema), async (req, res) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const agent = await agentSvc.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const servers = await svc.setAgentMcpServers(agentId, agent.companyId, req.body.mcpServerIds);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.mcp_servers.updated",
      entityType: "agent",
      entityId: agentId,
      details: { mcpServerIds: req.body.mcpServerIds },
    });

    res.json(servers);
  });

  return router;
}
