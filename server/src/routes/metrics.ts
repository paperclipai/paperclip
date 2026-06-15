import { Router } from "express";
import { renderRunReconcilerPrometheusMetrics } from "../services/recovery/run-reconciler-metrics.js";

export function metricsRoutes() {
  const router = Router();

  router.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderRunReconcilerPrometheusMetrics());
  });

  return router;
}
