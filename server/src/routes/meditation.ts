import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { meditationLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TECHNIQUES = new Set([
  "mindfulness", "breath_focus", "body_scan", "loving_kindness",
  "visualization", "mantra", "transcendental", "movement", "other",
]);

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function meditationRoutes(db: Db) {
  const router = Router();

  /**
   * GET /meditation
   * Returns meditation logs for the authenticated user within [from, to].
   * Ordered by session_date desc, then created_at asc. Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/meditation", async (req, res) => {
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
      .from(meditationLogs)
      .where(
        and(
          eq(meditationLogs.companyId, companyId),
          eq(meditationLogs.userId, userId),
          gte(meditationLogs.sessionDate, from),
          lte(meditationLogs.sessionDate, to),
        ),
      )
      .orderBy(desc(meditationLogs.sessionDate), asc(meditationLogs.createdAt));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /meditation
   * Log a new meditation session. Multiple sessions per day are allowed.
   * Body: { companyId, sessionDate, durationMinutes, technique?, notes? }
   */
  router.post("/meditation", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const sessionDate = parseDate(body["sessionDate"]);
    if (!sessionDate) throw badRequest("sessionDate must be YYYY-MM-DD");

    if (body["durationMinutes"] === undefined) throw badRequest("durationMinutes is required");
    if (typeof body["durationMinutes"] !== "number" || !Number.isInteger(body["durationMinutes"])) {
      throw badRequest("durationMinutes must be an integer");
    }
    if (body["durationMinutes"] < 1) throw badRequest("durationMinutes must be at least 1");

    const durationMinutes = body["durationMinutes"];

    let technique: string | null = null;
    if (body["technique"] !== undefined && body["technique"] !== null) {
      if (typeof body["technique"] !== "string") throw badRequest("technique must be a string");
      const t = body["technique"].trim();
      if (t && !VALID_TECHNIQUES.has(t)) {
        throw badRequest(`technique must be one of: ${[...VALID_TECHNIQUES].join(", ")}`);
      }
      technique = t || null;
    }

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() || null : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(meditationLogs)
      .values({
        companyId,
        userId,
        sessionDate,
        durationMinutes,
        technique: technique ?? undefined,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /meditation/:id
   * Remove a meditation session log by id.
   */
  router.delete("/meditation/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(meditationLogs)
      .where(eq(meditationLogs.id, id));
    if (!existing) throw notFound("Meditation log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Meditation log not found");

    await db.delete(meditationLogs).where(eq(meditationLogs.id, id));
    res.status(204).send();
  });

  return router;
}
