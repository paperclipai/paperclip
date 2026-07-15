/**
 * Express middleware for OpenTelemetry HTTP metrics collection.
 *
 * Records request count and duration. Metrics are no-ops when no
 * MeterProvider is registered (i.e. when OTel is off).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { httpRequestsTotal, httpRequestDuration } from "./metrics.js";

/**
 * Middleware that records HTTP request metrics (count + duration).
 */
export function otelHttpMetrics(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = performance.now();

    res.on("finish", () => {
      const durationSec = (performance.now() - startTime) / 1000;
      const method = req.method;
      const route = (req as any).route?.path ?? "unmatched";
      const status = String(res.statusCode);

      httpRequestsTotal.add(1, { method, route, status });
      httpRequestDuration.record(durationSec, { method, route });
    });

    next();
  };
}
