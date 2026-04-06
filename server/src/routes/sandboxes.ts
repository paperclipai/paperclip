import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sandboxService } from "../services/sandboxes.js";
import { assertCompanyAccess, assertBoard } from "./authz.js";
import { notFound } from "../errors.js";

export function sandboxRoutes(db: Db) {
  const router = Router();
  const service = sandboxService(db);

  // List sandboxes for a company
  router.get("/companies/:companyId/sandboxes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    const rows = await service.list(companyId, agentId);
    res.json(rows);
  });

  // Get a specific sandbox
  router.get("/companies/:companyId/sandboxes/:sandboxId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await service.get(companyId, req.params.sandboxId);
    if (!row) throw notFound("Sandbox not found");
    res.json(row);
  });

  // Create a new sandbox environment
  router.post("/companies/:companyId/sandboxes", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await service.create(companyId, req.body);
    res.status(201).json(row);
  });

  // Start a sandbox
  router.post("/companies/:companyId/sandboxes/:sandboxId/start", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await service.start(companyId, req.params.sandboxId);
    if (!row) throw notFound("Sandbox not found");
    res.json(row);
  });

  // Stop a sandbox
  router.post("/companies/:companyId/sandboxes/:sandboxId/stop", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await service.stop(companyId, req.params.sandboxId);
    if (!row) throw notFound("Sandbox not found");
    res.json(row);
  });

  // Delete a sandbox
  router.delete("/companies/:companyId/sandboxes/:sandboxId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const deleted = await service.remove(companyId, req.params.sandboxId);
    if (!deleted) throw notFound("Sandbox not found");
    res.json({ ok: true });
  });

  // Update agent sandbox config
  router.patch("/companies/:companyId/agents/:agentId/sandbox-config", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const updated = await service.updateAgentSandboxConfig(companyId, req.params.agentId, req.body);
    if (!updated) throw notFound("Agent not found");
    res.json(updated);
  });

  return router;
}
