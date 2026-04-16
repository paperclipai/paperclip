import { Router } from "express";

/**
 * Proxies infrastructure health checks to an external health aggregator.
 *
 * Enable by setting `PAPERCLIP_HEALTH_URL` to the base URL of a service that
 * exposes `/api/infrastructure/health` (aggregate) and
 * `/api/infrastructure/health/:service` (per-service) endpoints returning
 * standardized JSON:
 *
 *   { status: "ok"|"degraded"|"error", services: { ... }, summary: { ... } }
 *
 * When the env var is unset these routes are not mounted.
 */

export const PAPERCLIP_HEALTH_URL = process.env.PAPERCLIP_HEALTH_URL;

export function infrastructureHealthRoutes() {
  const router = Router();
  const baseUrl = PAPERCLIP_HEALTH_URL!;

  router.get("/", async (_req, res) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const upstream = await fetch(
        `${baseUrl}/api/infrastructure/health`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      clearTimeout(timer);
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        status: "error",
        error: "Failed to reach infrastructure health endpoint",
      });
    }
  });

  router.get("/:service", async (req, res) => {
    const { service } = req.params;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const upstream = await fetch(
        `${baseUrl}/api/infrastructure/health/${encodeURIComponent(service)}`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      clearTimeout(timer);
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        status: "error",
        error: `Failed to reach health endpoint for ${service}`,
      });
    }
  });

  return router;
}
