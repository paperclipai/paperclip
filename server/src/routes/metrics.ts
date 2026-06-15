import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";
import { renderRunReconcilerPrometheusMetrics } from "../services/recovery/run-reconciler-metrics.js";

export function metricsRoutes(opts?: { metricsToken?: string | null }) {
  const router = Router();

  router.get("/metrics", (req: Request, res: Response) => {
    const expectedToken = opts?.metricsToken?.trim() || process.env.PAPERCLIP_METRICS_TOKEN?.trim();
    if (expectedToken) {
      const auth = req.headers.authorization ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const a = Buffer.from(provided);
      const b = Buffer.from(expectedToken);
      const equal = a.length === b.length && timingSafeEqual(a, b);
      if (!equal) {
        res.status(401).setHeader("WWW-Authenticate", 'Bearer realm="metrics"').send("Unauthorized");
        return;
      }
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderRunReconcilerPrometheusMetrics());
  });

  return router;
}
