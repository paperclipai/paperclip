import { Router } from "express";
import { listRecentRuns } from "../services/bba-memory/index.js";
import { assertCompanyAccess } from "./authz.js";

// TODO(future): filter runs by companyId via meta_json once multi-tenant
// bba-memory becomes a requirement. Currently bba-memory is a single global
// SQLite file shared across all companies on the instance.
export function bbaMemoryRoutes() {
  const router = Router();

  router.get("/companies/:companyId/bba-memory/recent-runs", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit;
    const parsed = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : NaN;
    const safeLimit = Number.isFinite(parsed) && parsed > 0 && parsed <= 200 ? parsed : 20;

    const runs = listRecentRuns(safeLimit);

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
        meta: r.meta_json ? JSON.parse(r.meta_json) : null,
      })),
    });
  });

  return router;
}
