import { Router } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { healthScores, userLocations, environmentalReadings } from "@paperclipai/db";
import { medicalDisclaimer, MEDICAL_DISCLAIMER_TEXT } from "../middleware/medical-disclaimer.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

export function healthLongevityRoutes(db: Db) {
  const router = Router();

  /**
   * GET /health/environmental-score
   *
   * Returns today's environmental health score and 30-day history for
   * the authenticated user. Requires board (user) authentication.
   *
   * Query params:
   *   companyId  (required) – the company scope
   *   userId     (optional) – defaults to the authenticated user; admins may specify another
   */
  router.get("/environmental-score", medicalDisclaimer, async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim().length > 0
        ? req.query.userId.trim()
        : req.actor.userId ?? null;

    if (!userId) throw badRequest("Could not resolve userId");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rows = await db
      .select()
      .from(healthScores)
      .where(
        and(
          eq(healthScores.companyId, companyId),
          eq(healthScores.userId, userId),
          gte(healthScores.scoredAt, thirtyDaysAgo),
        ),
      )
      .orderBy(desc(healthScores.scoredAt))
      .limit(31);

    const today = rows[0] ?? null;
    const history = rows.slice(1);

    res.json({
      disclaimer: MEDICAL_DISCLAIMER_TEXT,
      today: today
        ? {
            score: today.overallScore,
            colorTier: today.colorTier,
            scoredAt: today.scoredAt,
            confidenceFlag: today.confidenceFlag,
            partialSignals: today.partialSignals ?? [],
            components: {
              aqi: today.aqiComponent,
              uv: today.uvComponent,
              heatStress: today.heatStressComponent,
              greenspace: today.greenspaceComponent,
            },
          }
        : null,
      history: history.map((row) => ({
        score: row.overallScore,
        colorTier: row.colorTier,
        scoredAt: row.scoredAt,
        confidenceFlag: row.confidenceFlag,
      })),
    });
  });

  /**
   * GET /health/environmental-score/map
   *
   * Returns geospatial environmental health score data for map overlay.
   * Scoped to a company; no per-user filtering — returns aggregated grid data.
   *
   * Query params:
   *   companyId  (required)
   *   date       (optional, ISO date string, defaults to today)
   */
  router.get("/environmental-score/map", medicalDisclaimer, async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const dateParam = typeof req.query.date === "string" ? req.query.date.trim() : null;
    const targetDate = dateParam ? new Date(dateParam) : new Date();
    if (isNaN(targetDate.getTime())) throw badRequest("Invalid date parameter");

    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    // Aggregate latest score per user location for the target day
    const rows = await db
      .select({
        lat: userLocations.lat,
        lng: userLocations.lng,
        geohash: userLocations.geohash,
        overallScore: healthScores.overallScore,
        colorTier: healthScores.colorTier,
        scoredAt: healthScores.scoredAt,
      })
      .from(healthScores)
      .innerJoin(
        userLocations,
        and(
          eq(userLocations.userId, healthScores.userId),
          eq(userLocations.companyId, healthScores.companyId),
        ),
      )
      .where(
        and(
          eq(healthScores.companyId, companyId),
          gte(healthScores.scoredAt, startOfDay),
          lte(healthScores.scoredAt, endOfDay),
        ),
      )
      .orderBy(desc(healthScores.scoredAt));

    res.json({
      disclaimer: MEDICAL_DISCLAIMER_TEXT,
      date: targetDate.toISOString().slice(0, 10),
      points: rows.map((row) => ({
        lat: row.lat,
        lng: row.lng,
        geohash: row.geohash,
        score: row.overallScore,
        colorTier: row.colorTier,
        scoredAt: row.scoredAt,
      })),
    });
  });

  // ---- User location management --------------------------------------------------

  /**
   * GET /health/locations
   * List saved locations for the authenticated user.
   */
  router.get("/locations", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(userLocations)
      .where(and(eq(userLocations.companyId, companyId), eq(userLocations.userId, userId)))
      .orderBy(desc(userLocations.isDefault), asc(userLocations.createdAt));

    res.json({ locations: rows });
  });

  /**
   * POST /health/locations
   * Save a new location for the authenticated user.
   * Body: { companyId, lat, lng, label?, isDefault? }
   */
  router.post("/locations", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    const lat = typeof body["lat"] === "number" ? body["lat"] : null;
    const lng = typeof body["lng"] === "number" ? body["lng"] : null;
    const label = typeof body["label"] === "string" ? body["label"].trim() || null : null;
    const isDefault = body["isDefault"] === true;

    if (!companyId) throw badRequest("companyId is required");
    if (lat === null || isNaN(lat)) throw badRequest("lat is required and must be a number");
    if (lng === null || isNaN(lng)) throw badRequest("lng is required and must be a number");
    assertCompanyAccess(req, companyId);

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    if (isDefault) {
      await db
        .update(userLocations)
        .set({ isDefault: false })
        .where(
          and(
            eq(userLocations.companyId, companyId),
            eq(userLocations.userId, userId),
            eq(userLocations.isDefault, true),
          ),
        );
    }

    const [row] = await db
      .insert(userLocations)
      .values({ companyId, userId, lat, lng, label, isDefault })
      .returning();

    res.status(201).json(row);
  });

  /**
   * PATCH /health/locations/:id
   * Update label, coordinates, or default status for a location.
   * Body: { label?, lat?, lng?, isDefault? }
   */
  router.patch("/locations/:id", async (req, res) => {
    assertBoard(req);

    const { id } = req.params as { id: string };
    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(userLocations)
      .where(eq(userLocations.id, id));

    if (!existing) throw notFound("Location not found");
    assertCompanyAccess(req, existing.companyId);

    if (existing.userId !== userId) throw notFound("Location not found");

    const body = req.body as Record<string, unknown>;
    const updates: Partial<typeof existing> = {};

    if (typeof body["label"] === "string") updates.label = body["label"].trim() || null;
    if (typeof body["lat"] === "number" && !isNaN(body["lat"] as number)) {
      updates.lat = body["lat"] as number;
    }
    if (typeof body["lng"] === "number" && !isNaN(body["lng"] as number)) {
      updates.lng = body["lng"] as number;
    }
    if (body["isDefault"] === true) {
      await db
        .update(userLocations)
        .set({ isDefault: false })
        .where(
          and(
            eq(userLocations.companyId, existing.companyId),
            eq(userLocations.userId, userId),
            eq(userLocations.isDefault, true),
          ),
        );
      updates.isDefault = true;
    } else if (body["isDefault"] === false) {
      updates.isDefault = false;
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(userLocations)
      .set(updates)
      .where(eq(userLocations.id, id))
      .returning();

    res.json(updated);
  });

  /**
   * DELETE /health/locations/:id
   * Remove a saved location.
   */
  router.delete("/locations/:id", async (req, res) => {
    assertBoard(req);

    const { id } = req.params as { id: string };
    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(userLocations)
      .where(eq(userLocations.id, id));

    if (!existing) throw notFound("Location not found");
    assertCompanyAccess(req, existing.companyId);

    if (existing.userId !== userId) throw notFound("Location not found");

    await db.delete(userLocations).where(eq(userLocations.id, id));

    res.status(204).send();
  });

  /**
   * GET /health/locations/:id/readings
   * Return raw environmental readings for a saved location.
   *
   * Query params:
   *   from  (optional, ISO datetime, defaults to 7 days ago)
   *   to    (optional, ISO datetime, defaults to now)
   *   limit (optional, max 500, default 200)
   */
  router.get("/locations/:id/readings", async (req, res) => {
    assertBoard(req);

    const { id } = req.params as { id: string };
    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [location] = await db
      .select()
      .from(userLocations)
      .where(eq(userLocations.id, id));

    if (!location) throw notFound("Location not found");
    assertCompanyAccess(req, location.companyId);

    if (location.userId !== userId) throw notFound("Location not found");

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const fromParam = typeof req.query.from === "string" ? new Date(req.query.from) : sevenDaysAgo;
    const toParam = typeof req.query.to === "string" ? new Date(req.query.to) : new Date();

    if (isNaN(fromParam.getTime())) throw badRequest("Invalid from parameter");
    if (isNaN(toParam.getTime())) throw badRequest("Invalid to parameter");

    const rawLimit = parseInt(String(req.query.limit ?? "200"), 10);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 200 : Math.min(rawLimit, 500);

    const rows = await db
      .select()
      .from(environmentalReadings)
      .where(
        and(
          eq(environmentalReadings.locationId, id),
          gte(environmentalReadings.readingAt, fromParam),
          lte(environmentalReadings.readingAt, toParam),
        ),
      )
      .orderBy(desc(environmentalReadings.readingAt))
      .limit(limit);

    res.json({
      locationId: id,
      from: fromParam.toISOString(),
      to: toParam.toISOString(),
      readings: rows.map((r) => ({
        id: r.id,
        readingAt: r.readingAt,
        aqi: r.aqi,
        pm25: r.pm25,
        pm10: r.pm10,
        no2: r.no2,
        uvIndex: r.uvIndex,
        landSurfaceTemp: r.landSurfaceTemp,
        ndvi: r.ndvi,
        dataSource: r.dataSource,
      })),
    });
  });

  return router;
}
