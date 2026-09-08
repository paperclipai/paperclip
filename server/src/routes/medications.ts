import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { medicationLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function medicationsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /medications
   * Returns medication logs for the authenticated user within [from, to].
   * Ordered by medicationDate desc, then createdAt asc for same-day stability.
   * Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/medications", async (req, res) => {
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
      .from(medicationLogs)
      .where(
        and(
          eq(medicationLogs.companyId, companyId),
          eq(medicationLogs.userId, userId),
          gte(medicationLogs.medicationDate, from),
          lte(medicationLogs.medicationDate, to),
        ),
      )
      .orderBy(desc(medicationLogs.medicationDate), asc(medicationLogs.createdAt));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /medications
   * Log a new medication entry. Multiple medications per day are allowed.
   * Body: { companyId, medicationDate, medicationName, dosage?, taken?, notes? }
   */
  router.post("/medications", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const medicationDate = parseDate(body["medicationDate"]);
    if (!medicationDate) throw badRequest("medicationDate must be YYYY-MM-DD");

    const rawName = typeof body["medicationName"] === "string" ? body["medicationName"].trim() : "";
    if (!rawName) throw badRequest("medicationName is required");

    const dosage =
      typeof body["dosage"] === "string" ? body["dosage"].trim() || null : null;
    const taken = body["taken"] === false ? false : true;
    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(medicationLogs)
      .values({
        companyId,
        userId,
        medicationDate,
        medicationName: rawName,
        dosage: dosage ?? undefined,
        taken,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /medications/:id
   * Remove a medication log entry by id.
   */
  router.delete("/medications/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(medicationLogs).where(eq(medicationLogs.id, id));
    if (!existing) throw notFound("Medication log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Medication log not found");

    await db.delete(medicationLogs).where(eq(medicationLogs.id, id));
    res.status(204).send();
  });

  return router;
}
