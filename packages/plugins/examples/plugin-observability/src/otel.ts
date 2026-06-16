/**
 * OTel SDK initialization and management.
 *
 * Encapsulates the NodeSDK setup, metric/trace providers, and OTLP exporters
 * so that the worker can start/stop telemetry cleanly.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { metrics, trace, type Tracer, type Meter } from "@opentelemetry/api";
import type { ObservabilityConfig } from "./constants.js";
import { DEFAULT_CONFIG, PLUGIN_VERSION } from "./constants.js";

export interface OTelHandle {
  sdk: NodeSDK;
  tracer: Tracer;
  meter: Meter;
  shutdown(): Promise<void>;
}

/**
 * Initialise the OTel NodeSDK with configured exporters.
 *
 * Returns a handle containing the tracer, meter, and a shutdown function
 * that flushes all pending telemetry.
 */
export function initOTel(config: ObservabilityConfig): OTelHandle {
  const endpoint = config.otlpEndpoint ?? DEFAULT_CONFIG.otlpEndpoint;
  const serviceName = config.serviceName ?? DEFAULT_CONFIG.serviceName;
  const exportIntervalMs =
    config.metricExportIntervalMs ?? DEFAULT_CONFIG.metricExportIntervalMs;
  const traceTimeoutMs =
    config.traceExportTimeoutMs ?? DEFAULT_CONFIG.traceExportTimeoutMs;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: PLUGIN_VERSION,
    "paperclip.plugin": "observability",
    ...config.resourceAttributes,
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: exportIntervalMs,
  });

  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    exportTimeoutMillis: traceTimeoutMs,
  });

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    metricReader,
  });

  sdk.start();

  const tracer = trace.getTracer("paperclip-observability", PLUGIN_VERSION);
  const meter = metrics.getMeter("paperclip-observability", PLUGIN_VERSION);

  return {
    sdk,
    tracer,
    meter,
    async shutdown() {
      await sdk.shutdown();
    },
  };
}
