import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createClientSchema,
  updateClientSchema,
  createClientProjectSchema,
  updateClientProjectSchema,
  upsertClientInstructionsFileSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { clientInstructionsService, clientService, logActivity } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function clientRoutes(db: Db) {
  const router = Router();
  const svc = clientService(db);
  const instructions = clientInstructionsService();

  // ── Clients CRUD ──────────────────────────────────────────────

  router.get("/companies/:companyId/clients", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limitParam = req.query.limit as string | undefined;
    const offsetParam = req.query.offset as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : undefined;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : undefined;
    const result = await svc.list(companyId, { limit, offset });
    res.json(result);
  });

  router.get("/clients/:id", async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    res.json(client);
  });

  router.post("/companies/:companyId/clients", validate(createClientSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const client = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client.created",
      entityType: "client",
      entityId: client.id,
      details: { name: client.name },
    });
    res.status(201).json(client);
  });

  router.patch("/clients/:id", validate(updateClientSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Client not found");
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(id, existing.companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client.updated",
      entityType: "client",
      entityId: id,
      details: { changedKeys: Object.keys(req.body) },
    });
    res.json(updated);
  });

  router.delete("/clients/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Client not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(id, existing.companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client.deleted",
      entityType: "client",
      entityId: id,
      details: { name: existing.name },
    });
    res.json({ ok: true });
  });

  // ── Client Instructions ──────────────────────────────────────

  router.get("/clients/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    assertBoard(req);
    res.json(await instructions.getBundle(client.companyId, id));
  });

  router.get("/clients/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    assertBoard(req);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    res.json(await instructions.readFile(client.companyId, id, relativePath));
  });

  router.put("/clients/:id/instructions-bundle/file", validate(upsertClientInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const result = await instructions.writeFile(client.companyId, id, req.body.path, req.body.content);
    await logActivity(db, {
      companyId: client.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "client.instructions_file_updated",
      entityType: "client",
      entityId: id,
      details: {
        path: result.file.path,
        size: result.file.size,
      },
    });
    res.json(result.file);
  });

  router.delete("/clients/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    assertBoard(req);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(client.companyId, id, relativePath);
    await logActivity(db, {
      companyId: client.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "client.instructions_file_deleted",
      entityType: "client",
      entityId: id,
      details: { path: relativePath },
    });
    res.json(result.bundle);
  });

  // ── Client Projects CRUD ──────────────────────────────────────

  router.get("/clients/:id/projects", async (req, res) => {
    const id = req.params.id as string;
    const client = await svc.getById(id);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    const result = await svc.listProjects(id, client.companyId);
    res.json(result);
  });

  router.post("/clients/:id/projects", validate(createClientProjectSchema), async (req, res) => {
    const clientId = req.params.id as string;
    const client = await svc.getById(clientId);
    if (!client) throw notFound("Client not found");
    assertCompanyAccess(req, client.companyId);
    const cp = await svc.createProject(client.companyId, {
      ...req.body,
      clientId,
    });
    if (!cp) throw notFound("Client project not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: client.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client_project.created",
      entityType: "client_project",
      entityId: cp.id,
      details: { clientId, projectId: req.body.projectId },
    });
    res.status(201).json(cp);
  });

  router.patch("/client-projects/:id", validate(updateClientProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProjectById(id);
    if (!existing) throw notFound("Client project not found");
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.updateProject(id, existing.companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client_project.updated",
      entityType: "client_project",
      entityId: id,
      details: { clientId: existing.clientId, projectId: existing.projectId, changedKeys: Object.keys(req.body) },
    });
    res.json(updated);
  });

  router.delete("/client-projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getProjectById(id);
    if (!existing) throw notFound("Client project not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.removeProject(id, existing.companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "client_project.deleted",
      entityType: "client_project",
      entityId: id,
      details: { clientId: existing.clientId, projectId: existing.projectId },
    });
    res.json({ ok: true });
  });

  return router;
}
