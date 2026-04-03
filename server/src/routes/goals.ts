import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { createGoalSchema, updateGoalSchema } from "@ironworksai/shared";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCanWrite, assertCompanyAccess, getActorInfo } from "./authz.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    res.json(goal);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCanWrite(req, existing.companyId, db);
    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title, status: goal.status },
    });

    res.json(goal);
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCanWrite(req, existing.companyId, db);
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  // ── Key Results ──────────────────────────────────────────────────

  router.get("/companies/:companyId/goals/:goalId/key-results", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const results = await svc.listKeyResults(req.params.goalId as string);
    res.json(results);
  });

  router.post("/companies/:companyId/goals/:goalId/key-results", async (req, res) => {
    const companyId = req.params.companyId as string;
    const goalId = req.params.goalId as string;
    await assertCanWrite(req, companyId, db);
    const kr = await svc.createKeyResult(goalId, companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.key_result_created",
      entityType: "goal",
      entityId: goalId,
      details: { description: kr.description },
    });
    res.status(201).json(kr);
  });

  router.patch("/companies/:companyId/goals/:goalId/key-results/:krId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);
    const kr = await svc.updateKeyResult(req.params.krId as string, req.body);
    if (!kr) {
      res.status(404).json({ error: "Key result not found" });
      return;
    }
    res.json(kr);
  });

  router.delete("/companies/:companyId/goals/:goalId/key-results/:krId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);
    const kr = await svc.removeKeyResult(req.params.krId as string);
    if (!kr) {
      res.status(404).json({ error: "Key result not found" });
      return;
    }
    res.json(kr);
  });

  return router;
}
