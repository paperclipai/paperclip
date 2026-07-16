/**
 * Express middleware for OpenTelemetry HTTP metrics collection.
 *
 * Records request count and duration. Metrics are no-ops when no
 * MeterProvider is registered (i.e. when OTel is off).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { httpRequestsTotal, httpRequestDuration } from "./metrics.js";

/**
 * Derive a bounded route label from the request. Uses Express's matched
 * route pattern (e.g. "/api/companies/:companyId/issues") when available,
 * falling back to "unmatched" to avoid unbounded cardinality from raw
 * paths containing user IDs or other dynamic segments.
 */
function getRouteLabel(req: Request): string {
  const matched = (req as any).route?.path;
  if (matched) return matched;
  // No matched route — use a safe fallback to prevent metric cardinality explosion
  return "unmatched";
}

/**
 * Middleware that records HTTP request metrics (count + duration).
 */
export function otelHttpMetrics(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = performance.now();

    res.on("finish", () => {
      const durationSec = (performance.now() - startTime) / 1000;
      const method = req.method;
      const route = getRouteLabel(req);
      const status = String(res.statusCode);

      httpRequestsTotal.add(1, { method, route, status });
      httpRequestDuration.record(durationSec, { method, route, status });
    });

    next();
  };
}
