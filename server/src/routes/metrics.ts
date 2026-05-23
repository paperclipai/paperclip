import { Router } from "express";
import { renderMetrics } from "../observability/prom.js";

const PROMETHEUS_TEXT_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export function metricsRoutes() {
  const router = Router();

  router.get("/metrics", (_req, res) => {
    res
      .status(200)
      .set("Content-Type", PROMETHEUS_TEXT_CONTENT_TYPE)
      .end(renderMetrics());
  });

  return router;
}
