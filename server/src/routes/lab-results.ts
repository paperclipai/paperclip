import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { labResults } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = parseFloat(value);
    if (isFinite(n)) return n;
  }
  return null;
}

export function labResultsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /lab-results
   * Returns lab results for the authenticated user within [from, to].
   * Ordered by measuredDate desc, then createdAt asc for same-day stability.
   * Max range: 730 days (2 years — blood tests are infrequent).
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   */
  router.get("/lab-results", async (req, res) => {
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
    if (dayCount > 730) throw badRequest("date range must not exceed 730 days");

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(labResults)
      .where(
        and(
          eq(labResults.companyId, companyId),
          eq(labResults.userId, userId),
          gte(labResults.measuredDate, from),
          lte(labResults.measuredDate, to),
        ),
      )
      .orderBy(desc(labResults.measuredDate), asc(labResults.createdAt));

    res.json({ from, to, results: rows });
  });

  /**
   * POST /lab-results
   * Log a new lab result entry.
   * Body: { companyId, markerName, value, unit, measuredDate, loincCode?, optimalMin?, optimalMax?, source?, notes? }
   */
  router.post("/lab-results", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const measuredDate = parseDate(body["measuredDate"]);
    if (!measuredDate) throw badRequest("measuredDate must be YYYY-MM-DD");

    const rawMarker = typeof body["markerName"] === "string" ? body["markerName"].trim() : "";
    if (!rawMarker) throw badRequest("markerName is required");

    const rawValue = parseNumeric(body["value"]);
    if (rawValue === null) throw badRequest("value must be a number");

    const rawUnit = typeof body["unit"] === "string" ? body["unit"].trim() : "";
    if (!rawUnit) throw badRequest("unit is required");

    const loincCode =
      typeof body["loincCode"] === "string" ? body["loincCode"].trim() || null : null;
    const optimalMin = parseNumeric(body["optimalMin"]);
    const optimalMax = parseNumeric(body["optimalMax"]);
    const source = typeof body["source"] === "string" ? body["source"].trim() || null : null;
    const notes = typeof body["notes"] === "string" ? body["notes"].trim() || null : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(labResults)
      .values({
        companyId,
        userId,
        markerName: rawMarker,
        loincCode: loincCode ?? undefined,
        value: String(rawValue),
        unit: rawUnit,
        optimalMin: optimalMin !== null ? String(optimalMin) : undefined,
        optimalMax: optimalMax !== null ? String(optimalMax) : undefined,
        measuredDate,
        source: source ?? undefined,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /lab-results/:id
   * Remove a lab result entry by id.
   */
  router.delete("/lab-results/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(labResults).where(eq(labResults.id, id));
    if (!existing) throw notFound("Lab result not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Lab result not found");

    await db.delete(labResults).where(eq(labResults.id, id));
    res.status(204).send();
  });

  return router;
}
