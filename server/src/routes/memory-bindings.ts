import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  createMemoryBindingSchema,
  updateMemoryBindingSchema,
  createMemoryBindingTargetSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, memoryBindingService } from "../services/index.js";

export function memoryBindingRoutes(db: Db) {
  const router = Router();
  const svc = memoryBindingService(db);

  // ── Bindings (company-scoped) ────────────────────────────────────

  /** List all memory bindings for a company. */
  router.get("/companies/:companyId/memory-bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bindings = await svc.list(companyId);
    res.json(bindings);
  });

  /** Create a new memory binding. */
  router.post(
    "/companies/:companyId/memory-bindings",
    validate(createMemoryBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const binding = await svc.create(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_binding.created",
        entityType: "memory_binding",
        entityId: binding.id,
        details: { key: binding.key, providerKey: binding.providerKey },
      });

      res.status(201).json(binding);
    },
  );

  // ── Bindings (by ID) ─────────────────────────────────────────────

  /** Get a single memory binding by ID. */
  router.get("/memory-bindings/:id", async (req, res) => {
    const id = req.params.id as string;
    const binding = await svc.getById(id);
    if (!binding) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }
    assertCompanyAccess(req, binding.companyId);
    res.json(binding);
  });

  /** Update a memory binding. */
  router.patch(
    "/memory-bindings/:id",
    validate(updateMemoryBindingSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const binding = await svc.update(id, req.body);
      if (!binding) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_binding.updated",
        entityType: "memory_binding",
        entityId: binding.id,
        details: req.body,
      });

      res.json(binding);
    },
  );

  /** Delete a memory binding. */
  router.delete("/memory-bindings/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory_binding.deleted",
      entityType: "memory_binding",
      entityId: removed.id,
      details: { key: removed.key },
    });

    res.json({ ok: true });
  });

  // ── Binding Targets ──────────────────────────────────────────────

  /** List targets for a binding. */
  router.get("/memory-bindings/:bindingId/targets", async (req, res) => {
    const bindingId = req.params.bindingId as string;
    const binding = await svc.getById(bindingId);
    if (!binding) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }
    assertCompanyAccess(req, binding.companyId);

    const targets = await svc.listTargets(bindingId);
    res.json(targets);
  });

  /** Add a target assignment to a binding. */
  router.post(
    "/memory-bindings/:bindingId/targets",
    validate(createMemoryBindingTargetSchema),
    async (req, res) => {
      const bindingId = req.params.bindingId as string;
      const binding = await svc.getById(bindingId);
      if (!binding) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }
      assertCompanyAccess(req, binding.companyId);

      // Prevent cross-company target assignments
      if (req.body.targetType === "agent") {
        const [agent] = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, req.body.targetId));
        if (!agent || agent.companyId !== binding.companyId) {
          res.status(403).json({ error: "Target agent does not belong to this company" });
          return;
        }
      }
      if (req.body.targetType === "company" && req.body.targetId !== binding.companyId) {
        res.status(403).json({ error: "Company target must match the binding's company" });
        return;
      }

      let target;
      try {
        target = await svc.addTarget(bindingId, req.body);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          res.status(409).json({ error: "This target is already assigned to the binding" });
          return;
        }
        throw err;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_binding_target.created",
        entityType: "memory_binding_target",
        entityId: target.id,
        details: {
          bindingId,
          targetType: target.targetType,
          targetId: target.targetId,
        },
      });

      res.status(201).json(target);
    },
  );

  /** Remove a target assignment. */
  router.delete("/memory-binding-targets/:targetId", async (req, res) => {
    const targetId = req.params.targetId as string;
    const target = await svc.getTargetById(targetId);
    if (!target) {
      res.status(404).json({ error: "Memory binding target not found" });
      return;
    }

    const binding = await svc.getById(target.bindingId);
    if (!binding) {
      res.status(404).json({ error: "Memory binding not found" });
      return;
    }
    assertCompanyAccess(req, binding.companyId);

    const removed = await svc.removeTarget(targetId);
    if (!removed) {
      res.status(404).json({ error: "Memory binding target not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory_binding_target.deleted",
      entityType: "memory_binding_target",
      entityId: removed.id,
      details: {
        bindingId: removed.bindingId,
        targetType: removed.targetType,
        targetId: removed.targetId,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
