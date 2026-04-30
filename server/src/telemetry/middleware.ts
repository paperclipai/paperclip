/**
 * Express middleware for OpenTelemetry metrics collection.
 *
 * - Records HTTP request count and duration metrics
 * - Exposes /metrics endpoint for Prometheus scraping
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
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
 * This delegates to the PrometheusExporter's built-in handler.
 */
export function createMetricsHandler(): RequestHandler {
  return async (_req: Request, res: Response) => {
    try {
      // The PrometheusExporter is registered as a metric reader in the SDK.
      // We need to get its handler. Since we use preventServerStart: true,
      // we use the OpenTelemetry metrics API to collect and serialize.
      const { metrics } = await import("@opentelemetry/api");
      const meterProvider = metrics.getMeterProvider() as any;

      // Try to find the PrometheusExporter from the meter provider
      if (meterProvider._sharedState?.metricCollectors) {
        for (const collector of meterProvider._sharedState.metricCollectors) {
          const reader = collector._metricReader;
          if (reader instanceof PrometheusExporter) {
            // Use the exporter's internal handler
            reader.getMetricsRequestHandler()(_req as any, res as any);
            return;
          }
        }
      }

      // Fallback: try accessing _metricReaders directly
      if (typeof meterProvider.getMetricReader === "function") {
        const reader = meterProvider.getMetricReader();
        if (reader instanceof PrometheusExporter) {
          reader.getMetricsRequestHandler()(_req as any, res as any);
          return;
        }
      }

      res.status(503).send("# Prometheus exporter not available\n");
    } catch {
      res.status(503).send("# Metrics collection error\n");
    }
  };
}
