import { collectDefaultMetrics, register, Histogram, Counter } from "prom-client";
import type { Request, Response, NextFunction } from "express";

collectDefaultMetrics();

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/metrics") {
    next();
    return;
  }

  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path ?? req.baseUrl ?? req.path;
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response) {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
