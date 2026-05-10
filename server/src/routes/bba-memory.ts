import { Router } from "express";
import {
  listRecentRuns,
  listRecentRunsForCompany,
  getCompanyStatsSummary,
  safeParseMetaJson,
} from "../services/bba-memory/index.js";
import { assertCompanyAccess } from "./authz.js";

export function bbaMemoryRoutes() {
  const router = Router();

  router.get("/companies/:companyId/bba-memory/recent-runs", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit;
    const parsed = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : NaN;
    const safeLimit = Number.isFinite(parsed) && parsed > 0 && parsed <= 200 ? parsed : 20;

    // ?all=true is an instance-admin-only override that bypasses company filter.
    const actor = (req as any).actor;
    const wantsAll = req.query.all === "true";
    const isAdmin = actor?.type === "board" && actor?.isInstanceAdmin === true;
    const runs = wantsAll && isAdmin ? listRecentRuns(safeLimit) : listRecentRunsForCompany(companyId, safeLimit);

    res.json({
      companyId,
      limit: safeLimit,
      total: runs.length,
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        source: r.source,
        trigger: r.trigger,
        outcome: r.outcome,
        failureClass: r.failure_class,
        durationMs: r.duration_ms,
        meta: safeParseMetaJson(r.meta_json, r.id),
      })),
    });
  });

  router.get("/companies/:companyId/bba-memory/stats-summary", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const windowRaw = req.query.windowDays;
    const parsed = typeof windowRaw === "string" ? parseInt(windowRaw, 10) : NaN;
    const windowDays = !Number.isFinite(parsed) || parsed <= 0 ? 7 : Math.min(parsed, 90);

    res.json(getCompanyStatsSummary(companyId, windowDays));
  });

  return router;
}
