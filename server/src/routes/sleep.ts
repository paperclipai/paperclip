import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { sleepRecords } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_QUALITIES = new Set(["poor", "fair", "good", "excellent"]);

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function sleepRoutes(db: Db) {
  const router = Router();

  /**
   * GET /sleep
   * Returns sleep records for the authenticated user within [from, to].
   * Ordered by sleepDate desc. Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/sleep", async (req, res) => {
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
      .from(sleepRecords)
      .where(
        and(
          eq(sleepRecords.companyId, companyId),
          eq(sleepRecords.userId, userId),
          gte(sleepRecords.sleepDate, from),
          lte(sleepRecords.sleepDate, to),
        ),
      )
      .orderBy(desc(sleepRecords.sleepDate));

    res.json({ from, to, records: rows });
  });

  /**
   * POST /sleep
   * Log (or overwrite) a sleep entry for a given date.
   * Body: { companyId, sleepDate, durationMinutes, quality?, notes? }
   *
   * Uses an upsert so logging the same date twice replaces the previous entry.
   */
  router.post("/sleep", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const sleepDate = parseDate(body["sleepDate"]);
    if (!sleepDate) throw badRequest("sleepDate must be YYYY-MM-DD");

    const durationMinutes =
      typeof body["durationMinutes"] === "number" ? body["durationMinutes"] : null;
    if (durationMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw badRequest("durationMinutes must be a positive integer");
    }

    const quality =
      typeof body["quality"] === "string" && VALID_QUALITIES.has(body["quality"])
        ? body["quality"]
        : null;

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [row] = await db
      .insert(sleepRecords)
      .values({ companyId, userId, sleepDate, durationMinutes, quality, notes: notes ?? undefined })
      .onConflictDoUpdate({
        target: [sleepRecords.companyId, sleepRecords.userId, sleepRecords.sleepDate],
        set: { durationMinutes, quality, notes: notes ?? undefined, updatedAt: now },
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /sleep/:id
   * Remove a sleep record by id.
   */
  router.delete("/sleep/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(sleepRecords).where(eq(sleepRecords.id, id));
    if (!existing) throw notFound("Sleep record not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Sleep record not found");

    await db.delete(sleepRecords).where(eq(sleepRecords.id, id));
    res.status(204).send();
  });

  return router;
}
