import { Router } from "express";
import { desc, eq, and } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { goalCheckIns, goals } from "@ironworksai/db";
import { assertCompanyAccess, assertCanWrite, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { computeGoalHealth } from "../services/goal-health.js";

export function goalCheckInRoutes(db: Db) {
  const router = Router();

  // POST /api/companies/:companyId/goals/:goalId/check-ins
  router.post("/companies/:companyId/goals/:goalId/check-ins", async (req, res) => {
    const companyId = req.params.companyId as string;
    const goalId = req.params.goalId as string;
    await assertCanWrite(req, companyId, db);

    // Verify goal belongs to company
    const [goal] = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
      .limit(1);

    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const { progressPercent, confidence, status, note, blockers, nextSteps } = req.body as {
      progressPercent?: string;
      confidence?: number;
      status?: string;
      note?: string;
      blockers?: string;
      nextSteps?: string;
    };

    const actor = getActorInfo(req);
    const authorAgentId = actor.actorType === "agent" ? actor.actorId : null;
    const authorUserId = actor.actorType === "user" ? actor.actorId : null;

    const [checkIn] = await db
      .insert(goalCheckIns)
      .values({
        goalId,
        companyId,
        authorAgentId,
        authorUserId,
        progressPercent: progressPercent ?? null,
        confidence: confidence ?? null,
        status: status ?? "on_track",
        note: note ?? null,
        blockers: blockers ?? null,
        nextSteps: nextSteps ?? null,
      })
      .returning();

    // Update goal confidence if provided
    if (confidence !== undefined) {
      await db
        .update(goals)
        .set({ confidence, updatedAt: new Date() })
        .where(eq(goals.id, goalId));
    }

    // Recompute health after check-in
    await computeGoalHealth(db, goalId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.check_in_created",
      entityType: "goal",
      entityId: goalId,
      details: { status: checkIn.status, confidence: checkIn.confidence },
    });

    res.status(201).json(checkIn);
  });

  // GET /api/companies/:companyId/goals/:goalId/check-ins
  router.get("/companies/:companyId/goals/:goalId/check-ins", async (req, res) => {
    const companyId = req.params.companyId as string;
    const goalId = req.params.goalId as string;
    assertCompanyAccess(req, companyId);

    const checkIns = await db
      .select()
      .from(goalCheckIns)
      .where(and(eq(goalCheckIns.goalId, goalId), eq(goalCheckIns.companyId, companyId)))
      .orderBy(desc(goalCheckIns.createdAt))
      .limit(50);

    res.json(checkIns);
  });

  return router;
}
