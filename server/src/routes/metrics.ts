import { Router } from "express";
import { metricsRegistry, isMetricsEnabled } from "../observability/index.js";

/**
 * Prometheus /metrics endpoint.
 *
 * Enabled when PAPERCLIP_METRICS_ENABLED=true or PAPERCLIP_OTEL_ENDPOINT is set.
 * No authentication required — bind to a non-public network interface in production.
 */
export function metricsRoutes(): Router {
  const router = Router();

  if (!isMetricsEnabled()) {
    return router;
  }

  router.get("/metrics", async (_req, res) => {
    try {
      const metrics = await metricsRegistry.metrics();
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(metrics);
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  return router;
}
