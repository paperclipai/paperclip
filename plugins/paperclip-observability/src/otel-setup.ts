/**
 * OTel SDK v2 initialization and management.
 *
 * Uses the v2 API surface:
 *   - resourceFromAttributes() instead of new Resource()
 *   - traceExporter passed directly to NodeSDK (no manual BatchSpanProcessor)
 *   - Conditional exporter creation based on config flags
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  AggregationType,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { ViewOptions } from "@opentelemetry/sdk-metrics";
import { metrics, trace, type Tracer, type Meter } from "@opentelemetry/api";
import type { ObservabilityConfig } from "./config.js";
import { PLUGIN_ID } from "./constants.js";

// ---------------------------------------------------------------------------
// GenAI semantic-convention histogram bucket boundaries
// ---------------------------------------------------------------------------

/** Token usage histogram buckets per OTel GenAI semconv spec. */
export const TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];

/** Operation duration histogram buckets (seconds) per OTel GenAI semconv spec. */
export const OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

// ---------------------------------------------------------------------------
// Public handle type
// ---------------------------------------------------------------------------

export interface OTelHandle {
  sdk: NodeSDK;
  tracer: Tracer;
  meter: Meter;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SDK v2 metric views for GenAI histogram boundaries
// ---------------------------------------------------------------------------

function genAIMetricViews(): ViewOptions[] {
  return [
    {
      instrumentName: "gen_ai.client.token.usage",
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: TOKEN_USAGE_BUCKETS },
      },
    },
    {
      instrumentName: "gen_ai.client.operation.duration",
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: OPERATION_DURATION_BUCKETS },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialise the OTel NodeSDK v2 with configured exporters.
 *
 * Returns a handle containing the tracer, meter, and a shutdown function
 * that flushes all pending telemetry.
 */
export function initOTel(config: ObservabilityConfig): OTelHandle {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    "paperclip.plugin": PLUGIN_ID,
    ...config.resourceAttributes,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: config.enableTracing
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` })
      : undefined,
    metricReader: config.enableMetrics
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${config.otlpEndpoint}/v1/metrics`,
          }),
          exportIntervalMillis: config.exportIntervalMs,
        })
      : undefined,
    views: genAIMetricViews(),
  });

  sdk.start();

  const tracer = trace.getTracer(PLUGIN_ID, config.serviceVersion);
  const meter = metrics.getMeter(PLUGIN_ID, config.serviceVersion);

  return {
    sdk,
    tracer,
    meter,
    async shutdown() {
      await sdk.shutdown();
    },
  };
}
