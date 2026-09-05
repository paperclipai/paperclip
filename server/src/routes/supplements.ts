import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { supplements, supplementIntakes } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

function scheduledAtForDate(date: string, scheduledTime: string): Date {
  return new Date(`${date}T${scheduledTime}:00.000Z`);
}

export function supplementsRoutes(db: Db) {
  const router = Router();

  // ---- Supplement definitions -----------------------------------------------

  /**
   * GET /supplements
   * List all supplements for the authenticated user.
   */
  router.get("/supplements", async (req, res) => {
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
      .from(supplements)
      .where(and(eq(supplements.companyId, companyId), eq(supplements.userId, userId)))
      .orderBy(supplements.name);

    res.json({ supplements: rows });
  });

  /**
   * POST /supplements
   * Create a supplement definition.
   * Body: { companyId, name, dose, unit?, scheduledTime?, notes? }
   */
  router.post("/supplements", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    const name = typeof body["name"] === "string" ? body["name"].trim() : null;
    const dose = typeof body["dose"] === "string" ? body["dose"].trim() : null;
    const unit = typeof body["unit"] === "string" ? body["unit"].trim() : "mg";
    const scheduledTime =
      typeof body["scheduledTime"] === "string" ? body["scheduledTime"].trim() : "08:00";
    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    if (!companyId) throw badRequest("companyId is required");
    if (!name) throw badRequest("name is required");
    if (!dose) throw badRequest("dose is required");
    assertCompanyAccess(req, companyId);

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(supplements)
      .values({ companyId, userId, name, dose, unit, scheduledTime, notes: notes ?? undefined })
      .returning();

    res.status(201).json(row);
  });

  /**
   * PATCH /supplements/:id
   * Update a supplement definition.
   */
  router.patch("/supplements/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const [existing] = await db
      .select()
      .from(supplements)
      .where(eq(supplements.id, id));
    if (!existing) throw notFound("Supplement not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const patch: Partial<typeof supplements.$inferInsert> = {};
    if (typeof body["name"] === "string") patch.name = body["name"].trim();
    if (typeof body["dose"] === "string") patch.dose = body["dose"].trim();
    if (typeof body["unit"] === "string") patch.unit = body["unit"].trim();
    if (typeof body["scheduledTime"] === "string") patch.scheduledTime = body["scheduledTime"].trim();
    if (typeof body["notes"] === "string") patch.notes = body["notes"].trim();
    if (typeof body["active"] === "boolean") patch.active = body["active"];

    patch.updatedAt = new Date();

    const [updated] = await db
      .update(supplements)
      .set(patch)
      .where(eq(supplements.id, id))
      .returning();

    res.json(updated);
  });

  /**
   * DELETE /supplements/:id
   * Delete a supplement definition (and cascade its intakes).
   */
  router.delete("/supplements/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const [existing] = await db
      .select()
      .from(supplements)
      .where(eq(supplements.id, id));
    if (!existing) throw notFound("Supplement not found");
    assertCompanyAccess(req, existing.companyId);

    await db.delete(supplements).where(eq(supplements.id, id));
    res.status(204).send();
  });

  // ---- Daily intake ---------------------------------------------------------

  /**
   * GET /supplements/intake/:date
   * Returns all active supplements with their intake status for the given date.
   * Date format: YYYY-MM-DD (UTC).
   *
   * Query params:
   *   companyId (required)
   *   userId    (optional, defaults to actor)
   */
  router.get("/supplements/intake/:date", async (req, res) => {
    assertBoard(req);
    const { date } = req.params as { date: string };
    const parsedDate = parseDate(date);
    if (!parsedDate) throw badRequest("date must be YYYY-MM-DD");

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const activeSups = await db
      .select()
      .from(supplements)
      .where(
        and(
          eq(supplements.companyId, companyId),
          eq(supplements.userId, userId),
          eq(supplements.active, true),
        ),
      )
      .orderBy(supplements.scheduledTime, supplements.name);

    const intakeRows = await db
      .select()
      .from(supplementIntakes)
      .where(
        and(
          eq(supplementIntakes.companyId, companyId),
          eq(supplementIntakes.userId, userId),
          eq(supplementIntakes.intakeDate, parsedDate),
        ),
      );

    const intakeBySupplementId = new Map(intakeRows.map((r) => [r.supplementId, r]));

    const intakes = activeSups.map((sup) => {
      const intake = intakeBySupplementId.get(sup.id);
      return {
        id: intake?.id ?? sup.id,
        supplementId: sup.id,
        name: sup.name,
        dose: sup.dose,
        unit: sup.unit,
        scheduledAt: scheduledAtForDate(parsedDate, sup.scheduledTime).toISOString(),
        takenAt: intake?.takenAt?.toISOString() ?? null,
        skippedAt: intake?.skippedAt?.toISOString() ?? null,
      };
    });

    res.json({ date: parsedDate, intakes });
  });

  /**
   * POST /supplements/intake/:date/:supplementId/take
   * Mark a supplement as taken for a given date.
   * Creates an intake record if one doesn't exist; sets takenAt to now.
   */
  router.post("/supplements/intake/:date/:supplementId/take", async (req, res) => {
    assertBoard(req);
    const { date, supplementId } = req.params as { date: string; supplementId: string };
    const parsedDate = parseDate(date);
    if (!parsedDate) throw badRequest("date must be YYYY-MM-DD");

    const [sup] = await db
      .select()
      .from(supplements)
      .where(eq(supplements.id, supplementId));
    if (!sup) throw notFound("Supplement not found");
    assertCompanyAccess(req, sup.companyId);

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [existing] = await db
      .select()
      .from(supplementIntakes)
      .where(
        and(
          eq(supplementIntakes.supplementId, supplementId),
          eq(supplementIntakes.intakeDate, parsedDate),
          eq(supplementIntakes.userId, userId),
        ),
      );

    let intake;
    if (existing) {
      [intake] = await db
        .update(supplementIntakes)
        .set({ takenAt: now, skippedAt: null })
        .where(eq(supplementIntakes.id, existing.id))
        .returning();
    } else {
      [intake] = await db
        .insert(supplementIntakes)
        .values({
          supplementId,
          companyId: sup.companyId,
          userId,
          intakeDate: parsedDate,
          scheduledAt: scheduledAtForDate(parsedDate, sup.scheduledTime),
          takenAt: now,
        })
        .returning();
    }

    res.status(200).json({
      id: intake.id,
      supplementId: sup.id,
      name: sup.name,
      dose: sup.dose,
      unit: sup.unit,
      scheduledAt: scheduledAtForDate(parsedDate, sup.scheduledTime).toISOString(),
      takenAt: intake.takenAt?.toISOString() ?? null,
      skippedAt: intake.skippedAt?.toISOString() ?? null,
    });
  });

  /**
   * POST /supplements/intake/:date/:supplementId/skip
   * Mark a supplement as skipped for a given date.
   */
  router.post("/supplements/intake/:date/:supplementId/skip", async (req, res) => {
    assertBoard(req);
    const { date, supplementId } = req.params as { date: string; supplementId: string };
    const parsedDate = parseDate(date);
    if (!parsedDate) throw badRequest("date must be YYYY-MM-DD");

    const [sup] = await db
      .select()
      .from(supplements)
      .where(eq(supplements.id, supplementId));
    if (!sup) throw notFound("Supplement not found");
    assertCompanyAccess(req, sup.companyId);

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [existing] = await db
      .select()
      .from(supplementIntakes)
      .where(
        and(
          eq(supplementIntakes.supplementId, supplementId),
          eq(supplementIntakes.intakeDate, parsedDate),
          eq(supplementIntakes.userId, userId),
        ),
      );

    let intake;
    if (existing) {
      [intake] = await db
        .update(supplementIntakes)
        .set({ skippedAt: now, takenAt: null })
        .where(eq(supplementIntakes.id, existing.id))
        .returning();
    } else {
      [intake] = await db
        .insert(supplementIntakes)
        .values({
          supplementId,
          companyId: sup.companyId,
          userId,
          intakeDate: parsedDate,
          scheduledAt: scheduledAtForDate(parsedDate, sup.scheduledTime),
          skippedAt: now,
        })
        .returning();
    }

    res.status(200).json({
      id: intake.id,
      supplementId: sup.id,
      name: sup.name,
      dose: sup.dose,
      unit: sup.unit,
      scheduledAt: scheduledAtForDate(parsedDate, sup.scheduledTime).toISOString(),
      takenAt: intake.takenAt?.toISOString() ?? null,
      skippedAt: intake.skippedAt?.toISOString() ?? null,
    });
  });

  /**
   * DELETE /supplements/intake/:date/:supplementId
   * Remove an intake record (undo a take/skip).
   */
  router.delete("/supplements/intake/:date/:supplementId", async (req, res) => {
    assertBoard(req);
    const { date, supplementId } = req.params as { date: string; supplementId: string };
    const parsedDate = parseDate(date);
    if (!parsedDate) throw badRequest("date must be YYYY-MM-DD");

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    await db
      .delete(supplementIntakes)
      .where(
        and(
          eq(supplementIntakes.supplementId, supplementId),
          eq(supplementIntakes.intakeDate, parsedDate),
          eq(supplementIntakes.userId, userId),
        ),
      );

    res.status(204).send();
  });

  return router;
}
