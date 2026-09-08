import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { moodLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

function parseScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 10) return null;
  return value;
}

export function moodRoutes(db: Db) {
  const router = Router();

  /**
   * GET /mood
   * Returns mood logs for the authenticated user within [from, to].
   * Ordered by logDate desc. Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/mood", async (req, res) => {
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
      .from(moodLogs)
      .where(
        and(
          eq(moodLogs.companyId, companyId),
          eq(moodLogs.userId, userId),
          gte(moodLogs.logDate, from),
          lte(moodLogs.logDate, to),
        ),
      )
      .orderBy(desc(moodLogs.logDate));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /mood
   * Log (or overwrite) a mood entry for a given date.
   * Body: { companyId, logDate, moodScore, energyLevel?, notes? }
   *
   * Uses an upsert so logging the same date twice replaces the previous entry.
   */
  router.post("/mood", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const logDate = parseDate(body["logDate"]);
    if (!logDate) throw badRequest("logDate must be YYYY-MM-DD");

    if (body["moodScore"] === undefined) throw badRequest("moodScore is required");
    const moodScore = parseScore(body["moodScore"]);
    if (moodScore === null) throw badRequest("moodScore must be an integer between 1 and 10");

    let energyLevel: number | null = null;
    if (body["energyLevel"] !== undefined) {
      energyLevel = parseScore(body["energyLevel"]);
      if (energyLevel === null) throw badRequest("energyLevel must be an integer between 1 and 10");
    }

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [row] = await db
      .insert(moodLogs)
      .values({
        companyId,
        userId,
        logDate,
        moodScore,
        energyLevel: energyLevel ?? undefined,
        notes: notes ?? undefined,
      })
      .onConflictDoUpdate({
        target: [moodLogs.companyId, moodLogs.userId, moodLogs.logDate],
        set: {
          moodScore,
          energyLevel: energyLevel ?? undefined,
          notes: notes ?? undefined,
          updatedAt: now,
        },
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /mood/:id
   * Remove a mood log by id.
   */
  router.delete("/mood/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(moodLogs).where(eq(moodLogs.id, id));
    if (!existing) throw notFound("Mood log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Mood log not found");

    await db.delete(moodLogs).where(eq(moodLogs.id, id));
    res.status(204).send();
  });

  return router;
}
