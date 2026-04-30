/**
 * OpenTelemetry SDK initialization for Paperclip server.
 *
 * MUST be imported and called before any other server initialization
 * so that auto-instrumentations can hook into http/express modules.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  TraceIdRatioBasedSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { trace, type Tracer, type Span, SpanStatusCode, context } from "@opentelemetry/api";
import { resolveOtelConfig, type OtelConfig } from "./config.js";

let sdk: NodeSDK | null = null;
let otelConfig: OtelConfig | null = null;

/**
 * Initialize the OpenTelemetry SDK. Call once at startup before other imports.
 * Returns the resolved config for logging purposes.
 */
export function initOtel(): OtelConfig {
  const config = resolveOtelConfig();
  otelConfig = config;

  if (!config.enabled) {
    return config;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "unknown",
  });

  const sampler = new ParentBasedSampler({
    root: config.samplingRate >= 1
      ? new AlwaysOnSampler()
      : new TraceIdRatioBasedSampler(config.samplingRate),
  });

  // Trace exporter: OTLP if endpoint configured, otherwise noop
  const traceExporter = config.otlpEndpoint
    ? new OTLPTraceExporter({
        url: `${config.otlpEndpoint}/v1/traces`,
        headers: config.otlpHeaders,
      })
    : undefined;

  // Prometheus exporter serves /metrics on a separate port (if configured)
  // or mounted on the main express app via getMetricsRequestHandler()
  const prometheusExporter = new PrometheusExporter({
    port: config.prometheusPort,
    preventServerStart: !config.prometheusPort,
  });

  sdk = new NodeSDK({
    resource,
    sampler,
    traceExporter,
    metricReader: prometheusExporter,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          // Don't trace health checks or metrics endpoint
          const url = req.url ?? "";
          return url === "/health" || url === "/metrics" || url.startsWith("/health/");
        },
      }),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();

  return config;
}

/**
 * Gracefully shut down the OTel SDK (flush pending spans/metrics).
 */
export async function shutdownOtel(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

/**
 * Get the resolved OTel configuration (after init).
 */
export function getOtelConfig(): OtelConfig | null {
  return otelConfig;
}

// --- Convenience re-exports ---

export function getTracer(name = "paperclip-server"): Tracer {
  return trace.getTracer(name);
}

export { trace, context, SpanStatusCode };
export type { Span };
