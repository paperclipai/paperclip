import { Router } from "express";
import { metricsRegistry } from "../services/metrics.js";

/**
 * Prometheus metrics scrape endpoint.
 *
 * Mounted at the app level (not under /api) so Prometheus can scrape without
 * authentication. Access MUST be restricted at the network/ingress layer
 * (Traefik IP allowlist to the monitoring namespace only).
 */
export function metricsRoutes(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const metrics = await metricsRegistry.metrics();
      res.set("Content-Type", metricsRegistry.contentType).send(metrics);
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  return router;
}
