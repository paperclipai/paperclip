import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { exerciseLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ACTIVITY_TYPES = new Set([
  "running", "walking", "cycling", "swimming",
  "strength", "yoga", "hiit", "stretching", "other",
]);
const VALID_INTENSITY_LEVELS = new Set(["light", "moderate", "vigorous"]);

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function exerciseRoutes(db: Db) {
  const router = Router();

  /**
   * GET /exercise
   * Returns exercise logs for the authenticated user within [from, to].
   * Ordered by exercise_date desc, then created_at asc (to keep same-day entries stable).
   * Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/exercise", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from) throw badRequest("from must be YYYY-MM-DD");
    if (!to) throw badRequest("to must be YYYY-MM-DD");
    if (to < from) throw badRequest("to must be >= from");

    const msPerDay = 86_400_000;
    const dayCount =
      Math.round((new Date(to).getTime() - new Date(from).getTime()) / msPerDay) + 1;
    if (dayCount > 90) throw badRequest("date range must not exceed 90 days");

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(exerciseLogs)
      .where(
        and(
          eq(exerciseLogs.companyId, companyId),
          eq(exerciseLogs.userId, userId),
          gte(exerciseLogs.exerciseDate, from),
          lte(exerciseLogs.exerciseDate, to),
        ),
      )
      .orderBy(desc(exerciseLogs.exerciseDate), asc(exerciseLogs.createdAt));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /exercise
   * Log a new exercise session. Multiple sessions per day are allowed.
   * Body: { companyId, exerciseDate, activityType, durationMinutes, intensityLevel?, notes? }
   */
  router.post("/exercise", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const exerciseDate = parseDate(body["exerciseDate"]);
    if (!exerciseDate) throw badRequest("exerciseDate must be YYYY-MM-DD");

    const activityType =
      typeof body["activityType"] === "string" && VALID_ACTIVITY_TYPES.has(body["activityType"])
        ? body["activityType"]
        : null;
    if (!activityType)
      throw badRequest(
        `activityType must be one of: ${[...VALID_ACTIVITY_TYPES].join(", ")}`,
      );

    const durationMinutes =
      typeof body["durationMinutes"] === "number" ? body["durationMinutes"] : null;
    if (durationMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw badRequest("durationMinutes must be a positive integer");
    }

    const intensityLevel =
      typeof body["intensityLevel"] === "string" &&
      VALID_INTENSITY_LEVELS.has(body["intensityLevel"])
        ? body["intensityLevel"]
        : null;

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(exerciseLogs)
      .values({
        companyId,
        userId,
        exerciseDate,
        activityType,
        durationMinutes,
        intensityLevel: intensityLevel ?? undefined,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /exercise/:id
   * Remove an exercise log entry by id.
   */
  router.delete("/exercise/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(exerciseLogs).where(eq(exerciseLogs.id, id));
    if (!existing) throw notFound("Exercise log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Exercise log not found");

    await db.delete(exerciseLogs).where(eq(exerciseLogs.id, id));
    res.status(204).send();
  });

  return router;
}
