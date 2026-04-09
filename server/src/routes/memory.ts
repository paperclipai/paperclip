import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { memoryService } from "../services/memory.js";
import { logActivity } from "../services/index.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  // -- Bindings ----------------------------------------------------------------

  router.get("/companies/:companyId/memory/bindings", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bindings = await svc.listBindings(companyId);
    res.json(bindings);
  });

  router.post("/companies/:companyId/memory/bindings", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { bindingKey, providerKey, pluginId, displayName, configJson, enabled } = req.body as Record<string, unknown>;

    if (typeof bindingKey !== "string" || !bindingKey.trim()) {
      res.status(400).json({ error: "bindingKey is required" });
      return;
    }
    if (typeof providerKey !== "string" || !providerKey.trim()) {
      res.status(400).json({ error: "providerKey is required" });
      return;
    }

    const created = await svc.createBinding(companyId, {
      bindingKey: bindingKey.trim(),
      providerKey: providerKey.trim(),
      pluginId: typeof pluginId === "string" ? pluginId : null,
      displayName: typeof displayName === "string" ? displayName : null,
      configJson: configJson != null && typeof configJson === "object" ? configJson as Record<string, unknown> : null,
      enabled: typeof enabled === "boolean" ? enabled : true,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "memory_binding.created",
      entityType: "memory_binding",
      entityId: created!.id,
      details: { bindingKey: created!.bindingKey, providerKey: created!.providerKey },
    });

    res.status(201).json(created);
  });

  router.get("/companies/:companyId/memory/bindings/:key", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);
    const binding = await svc.getBinding(companyId, key);
    if (!binding) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }
    res.json(binding);
  });

  router.patch("/companies/:companyId/memory/bindings/:key", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);

    const { displayName, configJson, enabled } = req.body as Record<string, unknown>;

    const updated = await svc.updateBinding(companyId, key, {
      displayName: displayName !== undefined ? (typeof displayName === "string" ? displayName : null) : undefined,
      configJson: configJson !== undefined ? (configJson != null && typeof configJson === "object" ? configJson as Record<string, unknown> : null) : undefined,
      enabled: typeof enabled === "boolean" ? enabled : undefined,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "memory_binding.updated",
      entityType: "memory_binding",
      entityId: updated!.id,
      details: { bindingKey: key },
    });

    res.json(updated);
  });

  // -- Operations log ----------------------------------------------------------

  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
    const bindingKey = typeof req.query.bindingKey === "string" ? req.query.bindingKey : null;
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
    const limit = typeof req.query.limit === "string" ? Math.min(500, Math.max(1, parseInt(req.query.limit, 10))) : 100;
    const offset = typeof req.query.offset === "string" ? Math.max(0, parseInt(req.query.offset, 10)) : 0;

    const operations = await svc.listOperations(companyId, {
      agentId,
      bindingKey,
      from,
      to,
      limit,
      offset,
    });
    res.json(operations);
  });

  return router;
}
