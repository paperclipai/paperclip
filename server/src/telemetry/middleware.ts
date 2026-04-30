/**
 * Express middleware for OpenTelemetry metrics collection.
 *
 * - Records HTTP request count and duration metrics
 * - Exposes /metrics endpoint for Prometheus scraping
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
      const route = (req as any).route?.path ?? req.path;
      const status = String(res.statusCode);

      httpRequestsTotal.add(1, { method, route, status });
      httpRequestDuration.record(durationSec, { method, route });
    });

    next();
  };
}

/**
 * Handler for the /metrics Prometheus scrape endpoint.
 * Delegates to the PrometheusExporter's built-in HTTP handler.
 */
export function createMetricsHandler(): RequestHandler {
  // Lazy-import to avoid circular deps and ensure SDK is initialized
  let handler: ((req: any, res: any) => void) | null = null;

  return (req: Request, res: Response) => {
    if (!handler) {
      try {
        // The PrometheusExporter is registered as the metricReader on the SDK.
        // Access it through the metrics API meter provider internals.
        const { metrics } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
        const meterProvider = metrics.getMeterProvider() as any;

        // Walk the meter provider to find the PrometheusExporter
        const { PrometheusExporter } = require("@opentelemetry/exporter-prometheus") as typeof import("@opentelemetry/exporter-prometheus");

        const readers = meterProvider?._sharedState?.metricCollectors;
        if (readers) {
          for (const collector of readers) {
            const reader = collector._metricReader;
            if (reader instanceof PrometheusExporter) {
              handler = (rq: any, rs: any) => reader.getMetricsRequestHandler(rq, rs);
              break;
            }
          }
        }
      } catch {
        // SDK not initialized or Prometheus exporter not found
      }
    }

    if (handler) {
      handler(req, res);
    } else {
      res.status(503).type("text/plain").send("# Prometheus exporter not available\n");
    }
  };
}
