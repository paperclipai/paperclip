import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  bindAgentMcpServerSchema,
  createMcpServerSchema,
  testMcpServerSchema,
  transitionMcpServerGovernanceSchema,
  updateAgentMcpServerBindingSchema,
  updateMcpServerSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { agentService, logActivity, mcpServerService, secretService } from "../services/index.js";
import { mcpServerGovernanceService } from "../services/mcp-server-governance.js";

export function mcpServerRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const svc = mcpServerService(db, {
    secrets: secretService(db),
  });
  const governance = mcpServerGovernanceService(db);

  router.get("/companies/:companyId/mcp-servers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const servers = await svc.list(companyId);
    res.json(servers);
  });

  router.post("/companies/:companyId/mcp-servers", validate(createMcpServerSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(companyId, req.body, {
      userId: req.actor.userId ?? "board",
      agentId: null,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.created",
      entityType: "mcp_server",
      entityId: created.id,
      details: { name: created.name, slug: created.slug, transport: created.transport },
    });

    res.status(201).json(created);
  });

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

  router.get("/mcp-servers/:id/catalog-snapshots/latest", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const server = await svc.getById(id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, server.companyId);
    const snapshot = await svc.getLatestSnapshot(id);
    if (!snapshot) {
      res.status(404).json({ error: "MCP server snapshot not found" });
      return;
    }
    res.json(snapshot);
  });

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
      details: { name: updated.name, slug: updated.slug, transport: updated.transport },
    });

    res.json(updated);
  });

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
      details: { name: removed.name, slug: removed.slug },
    });

    res.json({ ok: true });
  });

  router.post("/mcp-servers/:id/test", validate(testMcpServerSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const server = await svc.getById(id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, server.companyId);

    const result = await svc.discover(id, req.body, {
      userId: req.actor.userId ?? "board",
      agentId: null,
    });

    await logActivity(db, {
      companyId: server.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: result.ok ? "mcp_server.tested" : "mcp_server.test_failed",
      entityType: "mcp_server",
      entityId: server.id,
      details: {
        snapshotId: result.snapshot.id,
        status: result.snapshot.status,
        summary: result.snapshot.summary,
        error: result.snapshot.error,
      },
    });

    res.status(result.ok ? 200 : 422).json(result);
  });

  // Governance: admin-only transition (board-level authz required)
  router.post(
    "/mcp-servers/:id/governance/transition",
    validate(transitionMcpServerGovernanceSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const server = await svc.getById(id);
      if (!server) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }
      assertCompanyAccess(req, server.companyId);

      const updated = await governance.transition(
        server.companyId,
        id,
        req.body,
        { type: "user", id: req.actor.userId ?? null },
      );
      res.json(updated);
    },
  );

  // Governance: audit log for a server (board-level read)
  router.get("/mcp-servers/:id/governance/audit-log", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const server = await svc.getById(id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, server.companyId);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const entries = await governance.listAuditLog(server.companyId, id, limit);
    res.json(entries);
  });

  // Governance: trigger risk reclassification (board-level)
  router.post("/mcp-servers/:id/governance/refresh-risk", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const server = await svc.getById(id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    assertCompanyAccess(req, server.companyId);
    const updated = await governance.refreshRiskClassification(server.companyId, id);
    res.json(updated);
  });

  router.get("/agents/:id/mcp-servers", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const bindings = await svc.listBindingsForAgent(agent.id);
    res.json(bindings);
  });

  router.post("/agents/:id/mcp-servers", validate(bindAgentMcpServerSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const binding = await svc.bindToAgent(agent.companyId, agent.id, req.body, {
      userId: req.actor.userId ?? "board",
      agentId: null,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.mcp_server_bound",
      entityType: "agent",
      entityId: agent.id,
      details: {
        mcpServerId: binding.mcpServerId,
        bindingMode: binding.bindingMode,
        enabled: binding.enabled,
      },
    });

    res.status(201).json(binding);
  });

  router.patch(
    "/agents/:id/mcp-servers/:mcpServerId",
    validate(updateAgentMcpServerBindingSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const mcpServerId = req.params.mcpServerId as string;
      const agent = await agents.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      assertCompanyAccess(req, agent.companyId);

      const updated = await svc.updateAgentBinding(agent.id, mcpServerId, req.body);
      if (!updated) {
        res.status(404).json({ error: "Agent MCP binding not found" });
        return;
      }

      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent.mcp_server_binding_updated",
        entityType: "agent",
        entityId: agent.id,
        details: {
          mcpServerId: updated.mcpServerId,
          bindingMode: updated.bindingMode,
          enabled: updated.enabled,
        },
      });

      res.json(updated);
    },
  );

  router.delete("/agents/:id/mcp-servers/:mcpServerId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const mcpServerId = req.params.mcpServerId as string;
    const agent = await agents.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    const removed = await svc.removeAgentBinding(agent.id, mcpServerId);
    if (!removed) {
      res.status(404).json({ error: "Agent MCP binding not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.mcp_server_unbound",
      entityType: "agent",
      entityId: agent.id,
      details: {
        mcpServerId: removed.mcpServerId,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
