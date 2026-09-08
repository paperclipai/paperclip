import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { nutritionLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function nutritionRoutes(db: Db) {
  const router = Router();

  /**
   * GET /nutrition
   * Returns nutrition logs for the authenticated user within [from, to].
   * Ordered by logDate desc. Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/nutrition", async (req, res) => {
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
      .from(nutritionLogs)
      .where(
        and(
          eq(nutritionLogs.companyId, companyId),
          eq(nutritionLogs.userId, userId),
          gte(nutritionLogs.logDate, from),
          lte(nutritionLogs.logDate, to),
        ),
      )
      .orderBy(desc(nutritionLogs.logDate));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /nutrition
   * Log (or overwrite) a nutrition entry for a given date.
   * Body: { companyId, logDate, waterMl, calories?, proteinG?, notes? }
   *
   * Uses an upsert so logging the same date twice replaces the previous entry.
   */
  router.post("/nutrition", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const logDate = parseDate(body["logDate"]);
    if (!logDate) throw badRequest("logDate must be YYYY-MM-DD");

    if (body["waterMl"] === undefined) throw badRequest("waterMl is required");
    const waterMl = parsePositiveInt(body["waterMl"]);
    if (waterMl === null) throw badRequest("waterMl must be a non-negative integer");

    let calories: number | null = null;
    if (body["calories"] !== undefined && body["calories"] !== null) {
      calories = parsePositiveInt(body["calories"]);
      if (calories === null) throw badRequest("calories must be a non-negative integer");
    }

    let proteinG: number | null = null;
    if (body["proteinG"] !== undefined && body["proteinG"] !== null) {
      proteinG = parsePositiveInt(body["proteinG"]);
      if (proteinG === null) throw badRequest("proteinG must be a non-negative integer");
    }

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [row] = await db
      .insert(nutritionLogs)
      .values({
        companyId,
        userId,
        logDate,
        waterMl,
        calories: calories ?? undefined,
        proteinG: proteinG ?? undefined,
        notes: notes ?? undefined,
      })
      .onConflictDoUpdate({
        target: [nutritionLogs.companyId, nutritionLogs.userId, nutritionLogs.logDate],
        set: {
          waterMl,
          calories: calories ?? undefined,
          proteinG: proteinG ?? undefined,
          notes: notes ?? undefined,
          updatedAt: now,
        },
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /nutrition/:id
   * Remove a nutrition log by id.
   */
  router.delete("/nutrition/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(nutritionLogs).where(eq(nutritionLogs.id, id));
    if (!existing) throw notFound("Nutrition log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Nutrition log not found");

    await db.delete(nutritionLogs).where(eq(nutritionLogs.id, id));
    res.status(204).send();
  });

  return router;
}
