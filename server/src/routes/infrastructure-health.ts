import { Router } from "express";

const VIBE_HEALTH_URL = process.env.VIBE_HEALTH_URL ?? "http://vibe:8080";

export function infrastructureHealthRoutes() {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const upstream = await fetch(
        `${VIBE_HEALTH_URL}/api/infrastructure/health`,
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
        `${VIBE_HEALTH_URL}/api/infrastructure/health/${encodeURIComponent(service)}`,
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
