import { Router } from "express";
import { metricsRegistry } from "../observability/index.js";

/**
 * Prometheus /metrics endpoint.
 *
 * Always enabled — no authentication required.
 * Bind to a non-public network interface in production.
 */
export function metricsRoutes(): Router {
  const router = Router();

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
