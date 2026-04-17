import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { kpiService } from "../services/kpi.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function kpiRoutes(db: Db) {
  const router = Router();
  const svc = kpiService(db);

  /**
   * GET /companies/:companyId/kpi
   *
   * Compute KPI report on demand. Does not persist.
   * Query params:
   *   windowDays (int, 1–90, default 7) — lookback window
   */
  router.get("/companies/:companyId/kpi", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rawWindow = req.query.windowDays as string | undefined;
    let windowDays = 7;
    if (rawWindow !== undefined) {
      const parsed = Number.parseInt(rawWindow, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
        throw badRequest("windowDays must be an integer between 1 and 90");
      }
      windowDays = parsed;
    }

    const report = await svc.compute(companyId, windowDays);
    res.json(report);
  });

  /**
   * POST /companies/:companyId/kpi/snapshots
   *
   * Compute KPIs and persist as a snapshot for trend analysis.
   * Body (optional):
   *   { windowDays?: number }
   */
  router.post("/companies/:companyId/kpi/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rawWindow = req.body?.windowDays;
    let windowDays = 7;
    if (rawWindow !== undefined) {
      const parsed = Number(rawWindow);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
        throw badRequest("windowDays must be an integer between 1 and 90");
      }
      windowDays = Math.floor(parsed);
    }

    const { snapshot, report } = await svc.saveSnapshot(companyId, windowDays);
    res.status(201).json({ snapshot, report });
  });

  /**
   * GET /companies/:companyId/kpi/snapshots
   *
   * List saved KPI snapshots (newest first) for trend analysis.
   * Query params:
   *   limit (int, 1–52, default 12) — number of snapshots to return
   */
  router.get("/companies/:companyId/kpi/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rawLimit = req.query.limit as string | undefined;
    let limit = 12;
    if (rawLimit !== undefined) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 52) {
        throw badRequest("limit must be an integer between 1 and 52");
      }
      limit = parsed;
    }

    const snapshots = await svc.listSnapshots(companyId, { limit });
    res.json(snapshots);
  });

  return router;
}
