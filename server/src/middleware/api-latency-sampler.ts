import type { NextFunction, Request, Response } from "express";
import { apiLatencyTracker } from "../services/recovery/load-guard.js";

/**
 * RBR-1013 — feeds the process-local API latency tracker used by the
 * load-aware recovery gate and the productivity monitor's degraded-window
 * suppression. Records wall-clock request duration (from receipt to
 * response finish), which is exactly the quantity RBR-977 measured as
 * degrading under load (`GET /api/agents/me` 53.2s, a single POST 101.4s).
 *
 * Tags each sample with `req.actor.companyId` when available (the actor
 * middleware runs before this in most paths that matter for the
 * productivity monitor's per-company suppression check) so a company-scoped
 * reader can ask "was *this company's* API traffic slow" without another
 * company's unrelated load on a shared multi-tenant instance contaminating
 * the answer. The recovery-sweep reader intentionally stays host-wide
 * (omits `companyId`) since it is asking whether the instance itself is
 * degraded, not any one company's slice of it.
 */
export function apiLatencySampler() {
  return function apiLatencySamplerMiddleware(req: Request, res: Response, next: NextFunction) {
    const startedAt = Date.now();
    res.on("finish", () => {
      apiLatencyTracker.record(Date.now() - startedAt, Date.now(), req.actor?.companyId ?? null);
    });
    next();
  };
}
