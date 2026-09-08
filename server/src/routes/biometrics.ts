import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { biometricReadings } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parsePositiveFloat(value: unknown): number | null {
  if (typeof value !== "number" || isNaN(value) || value <= 0) return null;
  return value;
}

export function biometricsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /biometrics
   * Returns biometric readings for the authenticated user within [from, to].
   * Ordered by measurementDate desc. Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/biometrics", async (req, res) => {
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
      .from(biometricReadings)
      .where(
        and(
          eq(biometricReadings.companyId, companyId),
          eq(biometricReadings.userId, userId),
          gte(biometricReadings.measurementDate, from),
          lte(biometricReadings.measurementDate, to),
        ),
      )
      .orderBy(desc(biometricReadings.measurementDate));

    res.json({ from, to, readings: rows });
  });

  /**
   * POST /biometrics
   * Log (or overwrite) a biometric snapshot for a given date.
   * At least one of weightKg, systolicBp/diastolicBp, or restingHeartRate must be provided.
   * Body: { companyId, measurementDate, weightKg?, systolicBp?, diastolicBp?, restingHeartRate?, notes? }
   *
   * Uses an upsert so logging the same date twice replaces the previous entry.
   */
  router.post("/biometrics", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const measurementDate = parseDate(body["measurementDate"]);
    if (!measurementDate) throw badRequest("measurementDate must be YYYY-MM-DD");

    const weightKg = body["weightKg"] !== undefined ? parsePositiveFloat(body["weightKg"]) : undefined;
    if (body["weightKg"] !== undefined && weightKg === null) {
      throw badRequest("weightKg must be a positive number");
    }

    const systolicBp = body["systolicBp"] !== undefined ? parsePositiveInt(body["systolicBp"]) : undefined;
    if (body["systolicBp"] !== undefined && systolicBp === null) {
      throw badRequest("systolicBp must be a positive integer");
    }

    const diastolicBp = body["diastolicBp"] !== undefined ? parsePositiveInt(body["diastolicBp"]) : undefined;
    if (body["diastolicBp"] !== undefined && diastolicBp === null) {
      throw badRequest("diastolicBp must be a positive integer");
    }

    const restingHeartRate =
      body["restingHeartRate"] !== undefined ? parsePositiveInt(body["restingHeartRate"]) : undefined;
    if (body["restingHeartRate"] !== undefined && restingHeartRate === null) {
      throw badRequest("restingHeartRate must be a positive integer");
    }

    const hasAnyValue =
      weightKg !== undefined || systolicBp !== undefined || restingHeartRate !== undefined;
    if (!hasAnyValue) {
      throw badRequest("at least one of weightKg, systolicBp, or restingHeartRate is required");
    }

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const now = new Date();
    const [row] = await db
      .insert(biometricReadings)
      .values({
        companyId,
        userId,
        measurementDate,
        weightKg: weightKg ?? undefined,
        systolicBp: systolicBp ?? undefined,
        diastolicBp: diastolicBp ?? undefined,
        restingHeartRate: restingHeartRate ?? undefined,
        notes: notes ?? undefined,
      })
      .onConflictDoUpdate({
        target: [biometricReadings.companyId, biometricReadings.userId, biometricReadings.measurementDate],
        set: {
          weightKg: weightKg ?? undefined,
          systolicBp: systolicBp ?? undefined,
          diastolicBp: diastolicBp ?? undefined,
          restingHeartRate: restingHeartRate ?? undefined,
          notes: notes ?? undefined,
          updatedAt: now,
        },
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /biometrics/:id
   * Remove a biometric reading by id.
   */
  router.delete("/biometrics/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(biometricReadings)
      .where(eq(biometricReadings.id, id));
    if (!existing) throw notFound("Biometric reading not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Biometric reading not found");

    await db.delete(biometricReadings).where(eq(biometricReadings.id, id));
    res.status(204).send();
  });

  return router;
}
