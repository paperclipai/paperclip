import { Router } from "express";
import { and, eq, desc, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryOperations, memoryBindings } from "@paperclipai/db";
import {
  memoryWriteSchema,
  memoryQuerySchema,
  memoryForgetSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, assertAgentScope, getActorInfo } from "./authz.js";
import {
  logActivity,
  memoryBindingService,
  memoryOperationService,
} from "../services/index.js";

export function memoryOperationRoutes(db: Db) {
  const router = Router();
  const bindingSvc = memoryBindingService(db);
  const opSvc = memoryOperationService(db);

  // ── List operations (audit log) ─────────────────────────────────

  /** List memory operations for a company with optional filters. */
  router.get("/companies/:companyId/memory-operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const { bindingId, agentId, operationType, success, from, to } = req.query;

    const conditions = [eq(memoryOperations.companyId, companyId)];
    if (bindingId) conditions.push(eq(memoryOperations.bindingId, bindingId as string));
    if (agentId) conditions.push(eq(memoryOperations.agentId, agentId as string));
    if (operationType) conditions.push(eq(memoryOperations.operationType, operationType as string));
    if (success !== undefined) conditions.push(eq(memoryOperations.success, success === "true"));
    if (from) {
      const fromDate = new Date(from as string);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "Invalid 'from' date" });
        return;
      }
      conditions.push(gte(memoryOperations.createdAt, fromDate));
    }
    if (to) {
      const toDate = new Date(to as string);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: "Invalid 'to' date" });
        return;
      }
      conditions.push(lte(memoryOperations.createdAt, toDate));
    }

    const where = and(...conditions);

    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: memoryOperations.id,
          bindingId: memoryOperations.bindingId,
          bindingKey: memoryBindings.key,
          providerKey: memoryBindings.providerKey,
          operationType: memoryOperations.operationType,
          agentId: memoryOperations.agentId,
          projectId: memoryOperations.projectId,
          issueId: memoryOperations.issueId,
          runId: memoryOperations.runId,
          sourceRef: memoryOperations.sourceRef,
          usage: memoryOperations.usage,
          latencyMs: memoryOperations.latencyMs,
          success: memoryOperations.success,
          error: memoryOperations.error,
          createdAt: memoryOperations.createdAt,
        })
        .from(memoryOperations)
        .leftJoin(memoryBindings, eq(memoryOperations.bindingId, memoryBindings.id))
        .where(where)
        .orderBy(desc(memoryOperations.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(memoryOperations)
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({ items: rows, total: countResult?.count ?? 0, limit, offset });
  });

  /** Helper: look up binding, assert company access, return binding. */
  async function resolveAndAuthorize(req: import("express").Request) {
    const bindingId = req.params.bindingId as string;
    const binding = await bindingSvc.getById(bindingId);
    if (!binding) {
      return null;
    }
    assertCompanyAccess(req, binding.companyId);
    return binding;
  }

  // ── Write ────────────────────────────────────────────────────────

  router.post(
    "/memory-bindings/:bindingId/write",
    validate(memoryWriteSchema),
    async (req, res) => {
      const binding = await resolveAndAuthorize(req);
      if (!binding) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }
      if (req.body.scope.companyId !== binding.companyId) {
        res.status(403).json({ error: "Scope companyId does not match binding company" });
        return;
      }
      if (req.body.source.companyId !== binding.companyId) {
        res.status(403).json({ error: "Source companyId does not match binding company" });
        return;
      }
      assertAgentScope(req, req.body.scope);

      const result = await opSvc.write(binding.id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_operation.write",
        entityType: "memory_binding",
        entityId: binding.id,
        details: {
          recordCount: result.records.length,
          latencyMs: result.latencyMs,
        },
      });

      res.json(result);
    },
  );

  // ── Query ────────────────────────────────────────────────────────

  router.post(
    "/memory-bindings/:bindingId/query",
    validate(memoryQuerySchema),
    async (req, res) => {
      const binding = await resolveAndAuthorize(req);
      if (!binding) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }
      if (req.body.scope.companyId !== binding.companyId) {
        res.status(403).json({ error: "Scope companyId does not match binding company" });
        return;
      }
      assertAgentScope(req, req.body.scope);

      const result = await opSvc.query(binding.id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_operation.query",
        entityType: "memory_binding",
        entityId: binding.id,
        details: {
          snippetCount: result.snippets.length,
          latencyMs: result.latencyMs,
        },
      });

      res.json(result);
    },
  );

  // ── Forget ───────────────────────────────────────────────────────

  router.post(
    "/memory-bindings/:bindingId/forget",
    validate(memoryForgetSchema),
    async (req, res) => {
      const binding = await resolveAndAuthorize(req);
      if (!binding) {
        res.status(404).json({ error: "Memory binding not found" });
        return;
      }
      if (req.body.scope.companyId !== binding.companyId) {
        res.status(403).json({ error: "Scope companyId does not match binding company" });
        return;
      }
      assertAgentScope(req, req.body.scope);

      const result = await opSvc.forget(binding.id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_operation.forget",
        entityType: "memory_binding",
        entityId: binding.id,
        details: {
          handleCount: req.body.handles.length,
          latencyMs: result.latencyMs,
        },
      });

      res.json(result);
    },
  );

  return router;
}
