import { Router } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
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

  return router;
}
