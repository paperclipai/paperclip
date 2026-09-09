import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { healthGoals } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const VALID_GOAL_TYPES = [
  "water_ml",
  "sleep_minutes",
  "exercise_minutes",
  "meditation_minutes",
  "calories",
  "protein_g",
  "steps",
  "weight_kg",
  "mood_score",
];

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function healthGoalsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /health/goals
   * Returns all active goals for the authenticated user.
   * Query params: companyId (required), userId (optional, defaults to actor)
   */
  router.get("/health/goals", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(healthGoals)
      .where(
        and(
          eq(healthGoals.companyId, companyId),
          eq(healthGoals.userId, userId),
          eq(healthGoals.isActive, true),
        ),
      );

    res.json({ goals: rows });
  });

  /**
   * POST /health/goals
   * Upsert a health goal for a given goal_type (one active goal per type per user).
   * Body: { companyId, goalType, targetValue, unit, label, notes? }
   */
  router.post("/health/goals", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const goalType = typeof body["goalType"] === "string" ? body["goalType"].trim() : null;
    if (!goalType) throw badRequest("goalType is required");
    if (!VALID_GOAL_TYPES.includes(goalType)) {
      throw badRequest(`goalType must be one of: ${VALID_GOAL_TYPES.join(", ")}`);
    }

    const targetValue = parsePositiveInt(body["targetValue"]);
    if (targetValue === null) throw badRequest("targetValue must be a positive integer");

    const unit = typeof body["unit"] === "string" ? body["unit"].trim() : null;
    if (!unit) throw badRequest("unit is required");

    const label = typeof body["label"] === "string" ? body["label"].trim() : null;
    if (!label) throw badRequest("label is required");

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    // Deactivate any existing goal of this type before inserting the new one
    await db
      .update(healthGoals)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(healthGoals.companyId, companyId),
          eq(healthGoals.userId, userId),
          eq(healthGoals.goalType, goalType),
          eq(healthGoals.isActive, true),
        ),
      );

    const [row] = await db
      .insert(healthGoals)
      .values({
        companyId,
        userId,
        goalType,
        targetValue,
        unit,
        label,
        isActive: true,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * PATCH /health/goals/:id
   * Update a goal's target value, unit, label, or notes.
   * Body: { targetValue?, unit?, label?, notes? }
   */
  router.patch("/health/goals/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(healthGoals).where(eq(healthGoals.id, id));
    if (!existing) throw notFound("Health goal not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Health goal not found");

    const body = req.body as Record<string, unknown>;
    const updates: Partial<typeof existing> & { updatedAt: Date } = { updatedAt: new Date() };

    if (body["targetValue"] !== undefined) {
      const tv = parsePositiveInt(body["targetValue"]);
      if (tv === null) throw badRequest("targetValue must be a positive integer");
      updates.targetValue = tv;
    }
    if (body["unit"] !== undefined) {
      const unit = typeof body["unit"] === "string" ? body["unit"].trim() : null;
      if (!unit) throw badRequest("unit must be a non-empty string");
      updates.unit = unit;
    }
    if (body["label"] !== undefined) {
      const label = typeof body["label"] === "string" ? body["label"].trim() : null;
      if (!label) throw badRequest("label must be a non-empty string");
      updates.label = label;
    }
    if ("notes" in body) {
      updates.notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;
    }

    const [row] = await db
      .update(healthGoals)
      .set(updates)
      .where(eq(healthGoals.id, id))
      .returning();

    res.json(row);
  });

  /**
   * DELETE /health/goals/:id
   * Soft-delete a goal by marking it inactive.
   */
  router.delete("/health/goals/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(healthGoals).where(eq(healthGoals.id, id));
    if (!existing) throw notFound("Health goal not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Health goal not found");

    await db
      .update(healthGoals)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(healthGoals.id, id));

    res.status(204).send();
  });

  return router;
}
