export const PLUGIN_ID = "paperclip-observability";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  metricsFlush: "otel-metrics-flush",
} as const;

export const STREAM_CHANNELS = {
  telemetryStatus: "telemetry-status",
} as const;

/**
 * Default configuration values for the observability plugin.
 */
export const DEFAULT_CONFIG = {
  /** OTLP endpoint for exporting telemetry (gRPC or HTTP). */
  otlpEndpoint: "http://localhost:4318",

  /** OTLP protocol: "http/protobuf" or "grpc". */
  otlpProtocol: "http/protobuf" as "http/protobuf" | "grpc",

  /** Logical service name reported in OTel resource attributes. */
  serviceName: "paperclip",

  /** Metric export interval in milliseconds. */
  metricExportIntervalMs: 60_000,

  /** Trace export batch timeout in milliseconds. */
  traceExportTimeoutMs: 30_000,

  /** Whether to collect agent run spans. */
  enableTracing: true,

  /** Whether to collect metrics (counters, histograms). */
  enableMetrics: true,

  /** Whether to export structured logs via OTel. */
  enableLogs: false,

  /** Additional resource attributes as key=value pairs. */
  resourceAttributes: {} as Record<string, string>,
} as const;

export type ObservabilityConfig = {
  otlpEndpoint?: string;
  otlpProtocol?: "http/protobuf" | "grpc";
  serviceName?: string;
  metricExportIntervalMs?: number;
  traceExportTimeoutMs?: number;
  enableTracing?: boolean;
  enableMetrics?: boolean;
  enableLogs?: boolean;
  resourceAttributes?: Record<string, string>;
};
