import { Router } from "express";
import { register, collectDefaultMetrics, Histogram, Counter } from "prom-client";

// Collect Node.js default metrics (CPU, memory, event loop, GC, etc.)
collectDefaultMetrics({ prefix: "paperclip_" });

// Custom application metrics
export const httpRequestDuration = new Histogram({
  name: "paperclip_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new Counter({
  name: "paperclip_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
});

export function metricsRoutes() {
  const router = Router();

  router.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  return router;
}
